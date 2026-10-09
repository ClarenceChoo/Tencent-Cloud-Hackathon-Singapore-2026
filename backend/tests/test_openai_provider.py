"""Mocked OpenAI HTTP contracts; live-provider evidence is recorded separately."""
import asyncio
import io
import json
import wave

import httpx
import pytest

from app.openai_provider import OpenAIConfig, OpenAIProvider, from_environment
from app.openai_tools import CARE_TOOLS, function_tools, interpret_function_call
from app.providers import ProviderResponseError, ProviderUnavailable, SpeechTooLong
from app.services import validate_wav
from conftest import wav_bytes


def provider(handler):
    return OpenAIProvider(OpenAIConfig(api_key="sk-test-local-only"),httpx.MockTransport(handler))


def result(name, arguments):
    return {"status":"completed","output":[{"type":"function_call","status":"completed",
            "call_id":"call_test","name":name,"arguments":json.dumps(arguments)}]}


PAYLOADS = {
    "propose_health_note":{"wording":"Fictional sore knee","share_with_user_ids":[]},
    "report_medication":{"dose_instance_id":"dose_demo","report_state":"reported_not_yet"},
    "record_measurement":{"measurement_type":"blood_pressure","systolic":120,"diastolic":80,
        "unit":"mmHg","timezone":"Asia/Singapore","occurrence_text":"this morning",
        "source_description":"Fictional cuff","reporting_actor":"patient"},
    "update_preventive_task":{"task_id":"task_demo","state":"arranged"},
    "request_support":{"request_text":"Please help arrange a lift","recipient_user_id":"user_demo","urgency":"routine"},
    "update_followup":{"related_type":"health_note","related_id":"note_demo","check_at":"2026-10-04T01:00:00Z","permission_scope":"private"},
}


def test_function_definitions_are_strict_and_exclude_server_owned_fields():
    def objects(value):
        if isinstance(value,dict):
            if value.get("type")=="object":
                assert value["additionalProperties"] is False
                assert set(value["required"])==set(value["properties"])
            assert "default" not in value
            for child in value.values():objects(child)
        elif isinstance(value,list):
            for child in value:objects(child)
    tools=function_tools()
    assert len(tools)==11 and len({tool["name"] for tool in tools})==11
    for tool in tools:
        assert tool["strict"] is True
        objects(tool["parameters"])
        serialized=json.dumps(tool["parameters"])
        for field in ["plan_version","share_with_names","recipient_name","permitted_user_ids"]:
            assert field not in serialized


@pytest.mark.parametrize("name",PAYLOADS)
def test_care_tools_use_native_response_calls_and_nullable_optional_fields(name):
    payload=PAYLOADS[name]
    schema=next(tool for tool in function_tools() if tool["name"]==name)["parameters"]["properties"]["payload"]
    arguments={"operation":"propose","payload":{field:payload.get(field) for field in schema["properties"]}}
    def handle(request):
        assert str(request.url)=="https://api.openai.com/v1/responses"
        assert request.headers["Authorization"]=="Bearer sk-test-local-only"
        body=json.loads(request.content)
        assert body["tool_choice"]=="required" and body["parallel_tool_calls"] is False and body["store"] is False
        assert "native private history" not in request.content.decode()
        assert body["tools"]==function_tools()
        return httpx.Response(200,json=result(name,arguments))
    value=asyncio.run(provider(handle).interpret_turn("Fictional stated update",{"server_time":"2026-10-03T00:00:00Z","private_history":"native private history"}))
    assert value["intent"]=="proposal" and value["kind"]==CARE_TOOLS[name][0]
    for field,expected in payload.items():assert value["payload"][field]==expected


@pytest.mark.parametrize("name,arguments,intent",[
    ("confirm_current_update",{},"confirm"),
    ("get_medication_explanation",{"medicine_id":"medicine_demo"},"explain"),
    ("get_support_status",{"record_id":"support_demo"},"support_status"),
    ("get_followup_status",{"record_id":"follow_demo"},"followup_status"),
    ("respond_to_user",{"intent":"clarify","spoken_text":"Which medicine do you mean?"},"clarify"),
])
def test_read_confirmation_and_clarification_tools(name,arguments,intent):
    assert interpret_function_call(name,json.dumps(arguments))["intent"]==intent


@pytest.mark.parametrize("name,arguments",[
    ("run_shell",'{"command":"touch unwanted"}'),
    ("confirm_current_update",'{"confirmed":true}'),
    ("propose_health_note",'{"operation":"propose","payload":{"wording":"x","patient_id":"other"}}'),
    ("propose_health_note",'{"operation":"propose","payload":{"wording":"x","wording":"y"}}'),
    ("propose_health_note",json.dumps({"operation":"propose","payload":{"wording":"Fictional knee note", "occurrence_text":"this morning", "occurred_at":"2026-10-04T00:00:00+08:00"}})),
    ("report_medication",'{"operation":"propose","payload":{"dose_instance_id":"x","report_state":"reported_taken","plan_version":99}}'),
    ("request_support",'{"operation":"propose","payload":{"request_text":"x","recipient_user_id":"u","recipient_name":"invented"}}'),
    ("record_measurement",json.dumps({"operation":"propose","payload":{**PAYLOADS["record_measurement"],"systolic":999}})),
    ("respond_to_user",'{"intent":"confirm","spoken_text":"Saved."}'),
    ("get_support_status",'{"record_id":null}'),
    ("propose_health_note",'[]'),
    ("propose_health_note",'not json'),
])
def test_invalid_or_unauthorized_calls_are_rejected(name,arguments):
    with pytest.raises(ProviderResponseError):interpret_function_call(name,arguments)


@pytest.mark.parametrize("body",[
    {"status":"incomplete","output":[]},
    {"status":"completed","output":[{"type":"message","content":"Saved"}]},
    {"status":"completed","output":result("confirm_current_update",{})["output"]*2},
])
def test_missing_multiple_or_incomplete_tool_calls_fail_without_actions(body):
    with pytest.raises(ProviderResponseError):
        asyncio.run(provider(lambda _:httpx.Response(200,json=body)).interpret_turn("Test",{}))


def test_transcription_uploads_exact_validated_wav_without_a_key_in_the_body():
    wav=wav_bytes()
    def handle(request):
        assert request.url.path=="/v1/audio/transcriptions"
        assert wav in request.content
        assert b'gpt-4o-mini-transcribe' in request.content and b'sk-test-local-only' not in request.content
        return httpx.Response(200,json={"text":" Fictional sore knee. "})
    assert asyncio.run(provider(handle).transcribe_audio(wav))=="Fictional sore knee."


def test_speech_converts_openai_24khz_pcm_to_companion_16khz_wav():
    def handle(request):
        body=json.loads(request.content)
        assert request.url.path=="/v1/audio/speech" and body["response_format"]=="pcm"
        assert body["input"]=="Please confirm."
        return httpx.Response(200,content=b'\x01\x00'*24000)
    audio=asyncio.run(provider(handle).synthesise_speech("Please confirm."))
    assert 990<=validate_wav(audio)<=1010
    with wave.open(io.BytesIO(audio)) as wav:
        assert (wav.getframerate(),wav.getnchannels(),wav.getsampwidth())==(16000,1,2)


@pytest.mark.parametrize("status",[302,401,429,500])
def test_error_responses_and_redirects_never_expose_provider_bodies_or_keys(status):
    def handle(_):
        return httpx.Response(status,json={"error":{"message":"Private transcript sk-leak-me"}},headers={"Location":"https://external.invalid"})
    with pytest.raises(ProviderUnavailable) as error:
        asyncio.run(provider(handle).transcribe_audio(wav_bytes()))
    assert "Private transcript" not in str(error.value) and "sk-" not in str(error.value)
    assert "sk-test-local-only" not in repr(OpenAIConfig(api_key="sk-test-local-only"))


@pytest.mark.parametrize("pcm,error",[(b'',ProviderResponseError),(b'x',ProviderResponseError),(b'\x00\x00'*480001,SpeechTooLong)])
def test_speech_refuses_invalid_or_long_audio_without_trimming(pcm,error):
    with pytest.raises(error):asyncio.run(provider(lambda _:httpx.Response(200,content=pcm)).synthesise_speech("Test"))


def test_missing_key_fails_honestly(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY",raising=False)
    with pytest.raises(ProviderUnavailable):from_environment()
