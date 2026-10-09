"""Server-side OpenAI transcription, native function selection and speech."""
import asyncio
from dataclasses import dataclass, field
import json
import os

import httpx
from fastapi import HTTPException

from .providers import (ProviderResponseError, ProviderUnavailable, SpeechTooLong,
                        SYSTEM_PROMPT, pcm_wav, unsupported_vocabulary_capability,
                        validate_speech_wav)
from .openai_tools import function_tools, interpret_function_call


@dataclass(frozen=True)
class OpenAIConfig:
    api_key: str = field(repr=False)
    model: str = "gpt-4.1-mini"
    transcription_model: str = "gpt-4o-mini-transcribe"
    speech_model: str = "gpt-4o-mini-tts"
    voice: str = "coral"


class OpenAIProvider:
    def __init__(self, config: OpenAIConfig, transport=None):
        if not config.api_key.strip() or any(ch.isspace() for ch in config.api_key):
            raise ProviderUnavailable("OpenAI API key is missing or invalid. Check the server environment.")
        for model in (config.model, config.transcription_model, config.speech_model):
            if not model or len(model) > 120 or any(ch.isspace() for ch in model):
                raise ProviderUnavailable("OpenAI model configuration is invalid.")
        if config.voice not in {"alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"}:
            raise ProviderUnavailable("OpenAI voice configuration is invalid.")
        self.config, self.transport = config, transport

    def capabilities(self):
        return unsupported_vocabulary_capability()

    async def _request(self, path, *, json_body=None, data=None, files=None, binary=False):
        # A fixed OpenAI origin prevents configuration from forwarding the key to another host.
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10), follow_redirects=False, transport=self.transport) as client:
                async with client.stream("POST", "https://api.openai.com/v1/" + path,
                    headers={"Authorization": "Bearer " + self.config.api_key},
                    json=json_body, data=data, files=files) as response:
                    response.raise_for_status()
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 2 * 1024 * 1024:
                            raise ProviderResponseError("OpenAI response exceeded its size limit.")
            if binary:
                return bytes(body)
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ProviderResponseError("OpenAI returned an invalid response.")
            return result
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderUnavailable("OpenAI is unavailable. Check the server's API access and try again.") from exc

    async def transcribe_audio(self, wav, *, vocabulary=None):
        validate_speech_wav(wav)
        result = await self._request("audio/transcriptions",
            data={"model": self.config.transcription_model, "response_format": "json"},
            files={"file": ("recording.wav", wav, "audio/wav")})
        text = result.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 10000:
            raise ProviderResponseError("No clear speech was recognised. Please try again.")
        return text.strip()

    async def interpret_turn(self, transcript, context):
        if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 10000:
            raise ProviderResponseError("The transcript is invalid.")
        allowed = {key: context[key] for key in ("device", "server_time", "capture_intent", "reviewed_vocabulary",
            "current_proposal", "reminder_context", "active_medication_plan", "doses", "permitted_recipients",
            "health_notes", "preventive_tasks", "support_requests", "followups") if key in context}
        instructions = SYSTEM_PROMPT.replace("Return one JSON object only with keys intent, kind, payload, spoken_text.",
            "Call exactly one provided application function. Do not return JSON or free text outside that function.")
        instructions = instructions.replace("activate medication plans, call tools, claim a save",
            "activate medication plans, call unlisted tools, claim a save")
        instructions += "\nUse propose_health_note, report_medication, record_measurement, update_preventive_task, request_support or update_followup for proposed changes. Use operation=correct only for a complete revision of the identified current proposal. Use confirm_current_update only for an explicit confirmation with no corrections. Use get_medication_explanation, get_support_status or get_followup_status for grounded reads. Use respond_to_user for clarify or chat. Choose clarify when the transcript does not establish every required fact or an identifier is ambiguous. No function directly authorises a record commit. The server builds the authoritative read-back and checks confirmation separately."
        instructions += "\nSelect the specific function for the stated care event. A reported external blood-pressure reading with two numeric values belongs to record_measurement, not propose_health_note. Require the stated occurrence time and external measurement source; ask a clarification question if either is missing. A reported dose status for an identified checked-plan dose belongs to report_medication. Use propose_health_note for other general observations."
        result = await self._request("responses", json_body={
            "model": self.config.model, "instructions": instructions,
            "input": [{"role": "user", "content": json.dumps({"transcript": transcript, "context": allowed})}],
            "tools": function_tools(), "tool_choice": "required", "parallel_tool_calls": False,
            "max_output_tokens": 1800, "store": False,
        })
        if result.get("status") != "completed" or not isinstance(result.get("output"), list):
            raise ProviderResponseError("OpenAI did not complete the care tool call.")
        calls = [item for item in result["output"] if isinstance(item, dict) and item.get("type") == "function_call"]
        if len(calls) != 1 or calls[0].get("status") not in {None, "completed"}:
            raise ProviderResponseError("OpenAI must return exactly one completed care tool call.")
        return interpret_function_call(calls[0].get("name"), calls[0].get("arguments"))

    async def synthesise_speech(self, text):
        if not isinstance(text, str) or not text.strip() or len(text) > 600:
            raise ProviderResponseError("Reply text must be short and nonempty.")
        payload = {"model": self.config.speech_model, "voice": self.config.voice,
                   "input": text, "response_format": "pcm"}
        if self.config.speech_model.startswith("gpt-4o-mini-tts"):
            payload["instructions"] = "Read the exact supplied text clearly and calmly. Do not add, omit or paraphrase words."
        pcm = await self._request("audio/speech", json_body=payload, binary=True)
        if not pcm or len(pcm) % 2:
            raise ProviderResponseError("OpenAI speech returned invalid PCM.")
        if len(pcm) > 960000:
            raise SpeechTooLong("Speech output must fit a 20-second reply.")
        from .phone_audio import DECODER_SLOTS, _decode
        if not DECODER_SLOTS.acquire(blocking=False):
            raise ProviderUnavailable("Audio conversion is busy. Please retry shortly.")
        try:
            # OpenAI PCM is 24 kHz; every Parse companion consumes 16 kHz mono WAV.
            converted = await asyncio.to_thread(_decode, "ffmpeg", ["-nostdin", "-v", "error", "-threads", "1",
                "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"], pcm)
            return pcm_wav(converted)
        except HTTPException as exc:
            raise ProviderUnavailable("OpenAI speech could not be converted on this server.") from exc
        finally:
            DECODER_SLOTS.release()


def from_environment():
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise ProviderUnavailable("OpenAI API key is not configured on this server.")
    return OpenAIProvider(OpenAIConfig(api_key=key,
        model=os.getenv("CARELOOP_OPENAI_MODEL", "gpt-4.1-mini").strip(),
        transcription_model=os.getenv("CARELOOP_OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe").strip(),
        speech_model=os.getenv("CARELOOP_OPENAI_SPEECH_MODEL", "gpt-4o-mini-tts").strip(),
        voice=os.getenv("CARELOOP_OPENAI_VOICE", "coral").strip()))
