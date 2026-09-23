import asyncio
import base64
import hashlib
import io
import json
import wave

import httpx
import pytest

from app.providers import (FixtureProvider, ProviderResponseError, ProviderUnavailable, SpeechTooLong,
                           TencentConfig, TencentProvider, get_provider, parse_interpretation,
                           pcm_wav, tc3_headers, validate_speech_wav)


def config(**changes):
    values = dict(secret_id="test-only-id", secret_key="test-only-key", llm_api_key="test-only-llm",
                  llm_base_url="https://llm.example/v1", llm_model="configured-test-model", voice_type=1)
    values.update(changes)
    return TencentConfig(**values)


def test_only_valid_oversize_pcm_requests_text_splitting():
    with pytest.raises(SpeechTooLong):
        pcm_wav(b"\x00\x00" * 320001)
    for invalid in (b"", b"\x00", b"\x00" * 640001):
        with pytest.raises(ProviderResponseError) as error:
            pcm_wav(invalid)
        assert not isinstance(error.value, SpeechTooLong)


def run(coroutine):
    return asyncio.run(coroutine)


def test_wav_contract_rejects_bad_audio_and_normalises_good_audio():
    good = pcm_wav(b"\x01\x00" * 16000)
    assert validate_speech_wav(good) == good
    with wave.open(io.BytesIO(good)) as wav:
        assert wav.getparams()[:4] == (1, 2, 16000, 16000)
    for data in (b"", b"not audio", good[:-10]):
        with pytest.raises(ProviderResponseError):
            validate_speech_wav(data)
    with pytest.raises(ProviderResponseError):
        pcm_wav(b"\x00\x00" * 320001)


def test_tc3_signature_uses_utc_and_changes_when_payload_changes():
    args = dict(service="asr", host="asr.tencentcloudapi.com", action="SentenceRecognition",
                version="2019-06-14", secret_id="test-id", secret_key="test-key", timestamp=1551113065)
    headers = tc3_headers(body=b'{"a":1}', **args)
    assert "test-id/2019-02-25/asr/tc3_request" in headers["Authorization"]
    assert headers["X-TC-Timestamp"] == "1551113065"
    assert "test-key" not in headers["Authorization"]
    assert headers["Authorization"] != tc3_headers(body=b'{"a":2}', **args)["Authorization"]


def test_asr_upload_is_signed_and_contains_exact_wav_bytes():
    wav = pcm_wav(b"\x01\x00" * 16000)
    def handle(request):
        assert request.url == "https://asr.tencentcloudapi.com/"
        assert request.headers["x-tc-action"] == "SentenceRecognition"
        body = json.loads(request.content)
        assert body["SourceType"] == 1 and body["VoiceFormat"] == "wav"
        assert base64.b64decode(body["Data"]) == wav and body["DataLen"] == len(wav)
        assert "TC3-HMAC-SHA256" in request.headers["authorization"]
        return httpx.Response(200, json={"Response": {"Result": "My left knee aches."}})
    provider = TencentProvider(config(), httpx.MockTransport(handle))
    assert run(provider.transcribe_audio(wav)) == "My left knee aches."


def test_tts_pcm_becomes_device_compatible_wav():
    pcm = b"\x01\x00" * 16000
    def handle(request):
        body = json.loads(request.content)
        assert request.headers["x-tc-action"] == "TextToVoice"
        assert body["SampleRate"] == 16000 and body["Codec"] == "pcm"
        return httpx.Response(200, json={"Response": {"Audio": base64.b64encode(pcm).decode()}})
    audio = run(TencentProvider(config(), httpx.MockTransport(handle)).synthesise_speech("Is that right?"))
    with wave.open(io.BytesIO(audio)) as wav:
        assert wav.readframes(16000) == pcm


def test_llm_receives_only_allowed_context_and_output_is_structured():
    def handle(request):
        body = json.loads(request.content)
        assert request.url == "https://llm.example/v1/chat/completions"
        context = json.loads(body["messages"][1]["content"])["context"]
        assert "private_entire_history" not in context
        assert context["current_proposal"]["id"] == "p1"
        assert context["reminder_context"]["dose_instance_id"] == "dose1"
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"intent":"clarify","kind":null,"payload":{},"spoken_text":"Which medicine?"}'}}]})
    result = run(TencentProvider(config(), httpx.MockTransport(handle)).interpret_turn("I took it", {"current_proposal":{"id":"p1"},"reminder_context":{"dose_instance_id":"dose1"},"private_entire_history":"DO NOT SEND"}))
    assert result["intent"] == "clarify"


def test_provider_errors_do_not_expose_private_response_or_keys():
    def handle(request):
        return httpx.Response(200, json={"Response":{"Error":{"Message":"test-only-key: private transcript"}}})
    with pytest.raises(ProviderUnavailable) as caught:
        run(TencentProvider(config(), httpx.MockTransport(handle)).transcribe_audio(pcm_wav(b"\x01\x00" * 16000)))
    assert "private" not in str(caught.value) and "test-only-key" not in str(caught.value)


def test_redirects_and_insecure_configuration_fail():
    with pytest.raises(ProviderUnavailable):
        TencentProvider(config(llm_base_url="http://llm.example/v1"))
    with pytest.raises(ProviderUnavailable):
        TencentProvider(config(asr_host="attacker.example"))
    def handle(request):
        return httpx.Response(307, headers={"location":"https://unexpected.example/"})
    with pytest.raises(ProviderUnavailable):
        run(TencentProvider(config(), httpx.MockTransport(handle)).transcribe_audio(pcm_wav(b"\x01\x00" * 16000)))


@pytest.mark.parametrize("content", ['not json','[]','{"intent":"write_database"}','{"intent":"proposal","kind":"diagnosis"}','{"intent":"chat","payload":[]}'])
def test_invalid_llm_results_are_rejected(content):
    with pytest.raises(ProviderResponseError):
        parse_interpretation(content)


def test_fixture_mode_is_gated_and_requires_registered_audio(monkeypatch):
    monkeypatch.setenv("CARELOOP_PROVIDER", "fixture")
    monkeypatch.delenv("CARELOOP_TESTING", raising=False)
    with pytest.raises(ProviderUnavailable):
        get_provider()
    monkeypatch.setenv("CARELOOP_TESTING", "true")
    wav = pcm_wav(b"\x01\x00" * 16000)
    mapping = {hashlib.sha256(wav).hexdigest(): "yes"}
    provider = get_provider(mapping)
    assert run(provider.transcribe_audio(wav)) == "yes"
    with pytest.raises(ProviderUnavailable):
        run(provider.transcribe_audio(pcm_wav(b"\x02\x00" * 16000)))
    assert run(provider.interpret_turn("yes", {}))["intent"] == "clarify"
    assert run(provider.interpret_turn("yes", {"current_proposal":{"id":"p1"}}))["intent"] == "confirm"


def test_unconfigured_provider_fails_honestly(monkeypatch):
    monkeypatch.delenv("CARELOOP_PROVIDER", raising=False)
    with pytest.raises(ProviderUnavailable, match="not configured"):
        run(get_provider().transcribe_audio(b"anything"))
    monkeypatch.setenv("CARELOOP_PROVIDER", " ")
    with pytest.raises(ProviderUnavailable, match="not configured"):
        run(get_provider().transcribe_audio(b"anything"))
