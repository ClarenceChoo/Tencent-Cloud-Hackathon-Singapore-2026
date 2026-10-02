import asyncio
import json

import httpx
import pytest

from app.providers import (FixtureProvider, SpeechVocabulary, TencentProvider,
                           UnconfiguredProvider, pcm_wav)
from test_providers import config


@pytest.mark.parametrize("transcript", [
    "I took Fictional Med A, not Fictional Med B.",
    "I did not take two tablets.",
    "Ask Fictional Mae, not Fictional May.",
])
def test_unverified_tencent_hints_leave_request_and_material_words_unchanged(transcript):
    wav = pcm_wav(b"\x01\x00" * 16000)
    def handle(request):
        body = json.loads(request.content)
        assert request.headers["x-tc-action"] == "SentenceRecognition"
        assert body["EngSerViceType"] == "16k_en"
        assert "HotwordList" not in body and "HotwordId" not in body
        assert "CustomizationId" not in body and "ReplaceTextId" not in body
        return httpx.Response(200, json={"Response": {"Result": transcript}})
    provider = TencentProvider(config(), httpx.MockTransport(handle))
    assert provider.capabilities()["asr_vocabulary_supported"] is False
    assert provider.capabilities()["asr_vocabulary_applied"] is False
    actual = asyncio.run(provider.transcribe_audio(wav, vocabulary=SpeechVocabulary(3, ["Fictional Med A", "Fictional Mae"])))
    assert actual == transcript


def test_fixture_and_unconfigured_adapters_report_unsupported():
    for provider in (FixtureProvider(), UnconfiguredProvider()):
        assert provider.capabilities()["asr_vocabulary_supported"] is False
        assert provider.capabilities()["asr_vocabulary_applied"] is False


def test_interpreter_receives_only_reviewed_advisory_context():
    def handle(request):
        payload = json.loads(request.content)
        context = json.loads(payload["messages"][1]["content"])["context"]
        assert context["reviewed_vocabulary"] == {"version": 2, "terms": [{"canonical": "Fictional Med A", "aliases": ["Med A"], "category": "medicine"}]}
        assert "private_note" not in context
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"intent":"clarify","kind":null,"payload":{},"spoken_text":"Which medicine?"}'}}]})
    provider = TencentProvider(config(), httpx.MockTransport(handle))
    result = asyncio.run(provider.interpret_turn("I took it", {"reviewed_vocabulary": {"version": 2, "terms": [{"canonical": "Fictional Med A", "aliases": ["Med A"], "category": "medicine"}]}, "private_note": "never send"}))
    assert result["intent"] == "clarify"
