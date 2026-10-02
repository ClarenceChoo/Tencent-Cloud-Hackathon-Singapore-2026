"""Optional capture purposes bind to turn identity without creating care facts."""

from uuid import uuid4
from types import SimpleNamespace
import asyncio
import json

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException

from app import models as m
from app.providers import TencentProvider, ProviderResponseError, parse_interpretation
from conftest import wav_bytes
from test_device_protocol import auth
from test_phone_audio import m4a as m4a
from test_phone_identity import approve, enrollment
from test_web_companion import WEB, enroll, webm as webm
from test_providers import config


PURPOSES = ("health_note", "medication_report", "measurement", "support_request")


@pytest.fixture
def speech(monkeypatch):
    contexts = []

    class Speech:
        async def transcribe_audio(self, audio):
            return "I want to talk about the weather"

        async def interpret_turn(self, transcript, context):
            contexts.append(context)
            return {"intent": "chat", "spoken_text": "I heard you."}

        async def synthesise_speech(self, text):
            return wav_bytes()

    monkeypatch.setattr("app.worker._provider", lambda _: Speech())
    monkeypatch.setattr("app.providers.get_provider", lambda **_: Speech())
    return contexts


@pytest.mark.parametrize("purpose", [None, *PURPOSES])
def test_device_hint_is_advisory_and_idempotent(env, speech, purpose):
    client, app, ids = env
    key = str(uuid4())
    headers = {**auth(ids), "Content-Type": "audio/wav", "Idempotency-Key": key}
    if purpose:
        headers["X-Care-Intent"] = purpose
    first = client.post("/v1/device/turns", content=wav_bytes(), headers=headers)
    assert first.status_code == 202, first.text
    assert client.post("/v1/device/turns", content=wav_bytes(), headers=headers).json()["turn_id"] == first.json()["turn_id"]
    with app.state.db.SessionLocal() as db:
        turn = db.get(m.VoiceTurn, first.json()["turn_id"])
        assert turn.capture_intent == purpose
        assert db.scalars(select(m.ConfirmationProposal)).all() == []
        assert db.scalars(select(m.HealthNote)).all() == []
    assert speech[-1]["capture_intent"] == purpose
    changed = {**headers, "X-Care-Intent": "support_request" if purpose != "support_request" else "health_note"}
    assert client.post("/v1/device/turns", content=wav_bytes(), headers=changed).status_code == 409
    assert client.post("/v1/device/turns", content=wav_bytes(), headers={**headers, "Idempotency-Key": str(uuid4()), "X-Care-Intent": "unknown"}).status_code == 422
    assert client.post("/v1/device/turns", content=wav_bytes(), headers={**headers, "Idempotency-Key": str(uuid4()), "X-Care-Intent": ""}).status_code == 422


def test_phone_and_web_forward_validated_hint(env, speech, m4a, webm):
    client, app, ids = env
    created, phone_headers = enrollment(client)
    assert approve(client, ids, created.json()["code"]).status_code == 200
    phone = {**phone_headers, "Content-Type": "audio/mp4", "Idempotency-Key": str(uuid4()), "X-Care-Intent": "measurement"}
    first = client.post("/v1/phone/turns", content=m4a, headers=phone)
    assert first.status_code == 202, first.text
    assert client.post("/v1/phone/turns", content=m4a, headers=phone).json()["turn_id"] == first.json()["turn_id"]
    assert client.post("/v1/phone/turns", content=m4a, headers={**phone, "X-Care-Intent": "health_note"}).status_code == 409
    assert client.post("/v1/phone/turns", content=m4a, headers={**phone, "Idempotency-Key": str(uuid4()), "X-Care-Intent": "bad"}).status_code == 422
    assert speech[-1]["capture_intent"] == "measurement"

    browser = enroll(client)
    assert approve(client, ids, browser.json()["code"]).status_code == 200
    web_headers = {**WEB, "X-CSRF-Token": browser.json()["csrf_token"], "Idempotency-Key": str(uuid4()), "Content-Type": "audio/webm", "X-Care-Intent": "support_request"}
    assert client.post("/v1/web/turns", content=webm, headers={**web_headers, "X-CSRF-Token": "bad"}).status_code == 403
    assert client.post("/v1/web/turns", content=webm, headers={**web_headers, "Origin": "https://other.invalid"}).status_code == 403
    web_first = client.post("/v1/web/turns", content=webm, headers=web_headers)
    assert web_first.status_code == 202, web_first.text
    assert client.post("/v1/web/turns", content=webm, headers=web_headers).json()["turn_id"] == web_first.json()["turn_id"]
    assert client.post("/v1/web/turns", content=webm, headers={**web_headers, "X-Care-Intent": "health_note"}).status_code == 409
    assert client.post("/v1/web/turns", content=webm, headers={**web_headers, "Idempotency-Key": str(uuid4()), "X-Care-Intent": "bad"}).status_code == 422
    with app.state.db.SessionLocal() as db:
        assert db.get(m.VoiceTurn, web_first.json()["turn_id"]).capture_intent == "support_request"


def test_current_proposal_context_wins_over_hint(env, speech):
    client, app, ids = env
    from conftest import login
    response = client.post(f"/v1/app/patients/{ids['patient']}/proposals", json={"kind": "health_note", "payload": {"wording": "Fictional sore knee"}}, headers=login(client))
    assert response.status_code == 201, response.text
    proposal = response.json()
    headers = {**auth(ids), "Content-Type": "audio/wav", "Idempotency-Key": str(uuid4()), "X-Context-Id": proposal["context_id"], "X-Care-Intent": "measurement"}
    accepted = client.post("/v1/device/turns", content=wav_bytes(), headers=headers)
    assert accepted.status_code == 202, accepted.text
    assert speech[-1]["current_proposal"]["id"] == proposal["id"]
    assert speech[-1]["capture_intent"] == "measurement"
    with app.state.db.SessionLocal() as db:
        assert db.get(m.ConfirmationProposal, proposal["id"]).status == "pending"


def test_insert_race_compares_hint_as_part_of_request_identity(monkeypatch, speech):
    from app.turns import accept_turn
    from app.security import utcnow

    existing = SimpleNamespace(id="turn_winner", content_sha256="digest", context_id=None,
                               capture_intent="health_note", status="accepted", received_at=utcnow())

    class RaceSession:
        calls = 0

        def scalar(self, query):
            self.calls += 1
            return None if self.calls == 1 else existing

        def refresh(self, device):
            pass

        def add(self, turn):
            pass

        def commit(self):
            raise IntegrityError("INSERT", {}, Exception("winner inserted"))

        def rollback(self):
            pass

    monkeypatch.setattr("app.turns.lock_patient", lambda *_: None)
    device = SimpleNamespace(id="device", patient_id="patient", revoked_at=None, last_seen=None)
    args = (SimpleNamespace(state=SimpleNamespace(fixture_transcripts=None)), RaceSession(), device,
            b"audio", "digest", str(uuid4()), None, SimpleNamespace())
    with pytest.raises(HTTPException) as error:
        accept_turn(*args, capture_intent="measurement")
    assert error.value.status_code == 409
    accepted = accept_turn(args[0], RaceSession(), device, b"audio", "digest", str(uuid4()), None,
                           SimpleNamespace(), capture_intent="health_note")
    assert accepted["turn_id"] == "turn_winner"


def test_live_interpreter_receives_advisory_hint_and_current_proposal():
    def handle(request):
        body = json.loads(request.content)
        context = json.loads(body["messages"][1]["content"])["context"]
        assert context["capture_intent"] == "measurement"
        assert context["current_proposal"]["kind"] == "health_note"
        assert "unrelated_private_history" not in context
        assert "never evidence" in body["messages"][0]["content"]
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"intent":"clarify","kind":null,"payload":{},"spoken_text":"What would you like to change?"}'}}]})

    provider = TencentProvider(config(), httpx.MockTransport(handle))
    result = asyncio.run(provider.interpret_turn("Actually change that note", {
        "capture_intent": "measurement", "current_proposal": {"id": "prop_one", "kind": "health_note"},
        "unrelated_private_history": "do not send",
    }))
    assert result["intent"] == "clarify"
    with pytest.raises(ProviderResponseError):
        parse_interpretation('{"intent":"proposal","kind":"diagnosis","payload":{},"spoken_text":""}')
