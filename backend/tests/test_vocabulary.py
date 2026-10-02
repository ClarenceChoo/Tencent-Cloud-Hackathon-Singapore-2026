from datetime import timedelta
from uuid import uuid4
import asyncio

from app import models as m
from app.security import utcnow
from conftest import login
from conftest import wav_bytes
from test_device_protocol import auth


def path(patient):
    return f"/v1/app/patients/{patient}/vocabulary"


def test_reviewed_vocabulary_requires_profile_access_and_csrf(env):
    client, app, ids = env
    owner = login(client)
    assert client.get(path(ids["patient"])).status_code == 200
    assert client.put(path(ids["patient"]), json={"expected_version": 0, "terms": []},
                      headers={"Origin": "http://testserver"}).status_code == 403
    assert client.put(path(ids["patient"]), json={"expected_version": 0, "terms": []},
                      headers=owner).status_code == 200
    assert client.get(path(ids["other_patient"])).status_code == 403
    login(client, "caregiver@example.invalid", "caregiver-password")
    assert client.get(path(ids["patient"])).status_code == 403
    assert client.get(path(ids["patient"]) + "/suggestions").status_code == 403


def test_reviewed_save_is_versioned_and_audited_without_transcript_changes(env):
    client, app, ids = env
    headers = login(client)
    response = client.get(path(ids["patient"]))
    assert response.json() == {"version": 0, "terms": [], "reviewed_by_user_id": None, "reviewed_at": None}
    first = {"expected_version": 0, "terms": [{"canonical": " Fictional Med A ", "aliases": [" Med-A "], "category": "medicine"}]}
    saved = client.put(path(ids["patient"]), json=first, headers=headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 1
    assert saved.json()["terms"] == [{"canonical": "Fictional Med A", "aliases": ["Med-A"], "category": "medicine"}]
    assert saved.headers["cache-control"] == "private, no-store"
    stale = client.put(path(ids["patient"]), json=first, headers=headers)
    assert stale.status_code == 409
    second = client.put(path(ids["patient"]), json={"expected_version": 1, "terms": []}, headers=headers)
    assert second.status_code == 200 and second.json()["version"] == 2
    with app.state.db.SessionLocal() as db:
        audits = db.query(m.CareVocabularyAudit).filter_by(patient_id=ids["patient"]).order_by(m.CareVocabularyAudit.version).all()
        assert [item.version for item in audits] == [1, 2]
        assert audits[0].terms[0]["canonical"] == "Fictional Med A"
        assert audits[1].terms == []
        assert all(item.reviewed_by_user_id == ids["owner"] and item.reviewed_at for item in audits)


def test_bounds_and_normalized_collisions_are_rejected(env):
    client, app, ids = env
    headers = login(client)
    cases = [
        [{"canonical": "Ａlice", "aliases": [], "category": "person"}, {"canonical": "Alice", "aliases": [], "category": "person"}],
        [{"canonical": "Med A", "aliases": ["Med B"], "category": "medicine"}, {"canonical": "Med B", "aliases": [], "category": "medicine"}],
        [{"canonical": "A", "aliases": [str(i) for i in range(6)], "category": "other"}],
        [{"canonical": "X" * 81, "aliases": [], "category": "other"}],
        [{"canonical": str(i), "aliases": [], "category": "other"} for i in range(101)],
    ]
    for terms in cases:
        response = client.put(path(ids["patient"]), json={"expected_version": 0, "terms": terms}, headers=headers)
        assert response.status_code == 422, response.text
    assert client.get(path(ids["patient"])).json()["version"] == 0


def test_suggestions_use_only_active_checked_medicines_and_current_recipients(env):
    client, app, ids = env
    login(client)
    with app.state.db.SessionLocal() as db:
        db.add(m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore",
            source="Fictional checked label", checked_by_user_id=ids["owner"], checked_by_name="Owner",
            checked_at=utcnow(), active=True, medicines=[{"id": "med-a", "name": "Fictional Med A", "private_note": "do not expose"}], schedule=[]))
        db.commit()
    suggestions = client.get(path(ids["patient"]) + "/suggestions")
    assert suggestions.status_code == 200
    assert suggestions.headers["cache-control"] == "private, no-store"
    data = suggestions.json()["suggestions"]
    assert {item["canonical"] for item in data} == {"Fictional Med A", "Caregiver", "Second Caregiver"}
    assert all(item["aliases"] == [] and "private_note" not in item for item in data)
    assert client.get(path(ids["patient"])).json()["version"] == 0


def test_expired_profile_grant_cannot_read_or_write(env):
    client, app, ids = env
    with app.state.db.SessionLocal() as db:
        grant = db.query(m.AccessGrant).filter_by(user_id=ids["caregiver"], patient_id=ids["patient"]).one()
        grant.scopes = ["manage:profile"]
        grant.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    headers = login(client, "caregiver@example.invalid", "caregiver-password")
    assert client.get(path(ids["patient"])).status_code == 403
    assert client.put(path(ids["patient"]), json={"expected_version": 0, "terms": []}, headers=headers).status_code == 403


def test_worker_pins_reviewed_snapshot_across_new_save_and_plan_update(env, monkeypatch):
    from app.worker import process_turn
    client, app, ids = env
    headers = login(client)
    first = client.put(path(ids["patient"]), json={"expected_version": 0, "terms": [
        {"canonical": "Fictional Med A", "aliases": ["Med A"], "category": "medicine"}]}, headers=headers)
    assert first.status_code == 200
    observed = []
    class Speech:
        async def transcribe_audio(self, audio, *, vocabulary=None):
            observed.append(("asr", vocabulary.version, vocabulary.terms))
            return "I did not take two tablets of Fictional Med A."
        async def interpret_turn(self, transcript, context):
            observed.append(("interpret", transcript, context["reviewed_vocabulary"]))
            return {"intent": "clarify", "spoken_text": "Which medicine and amount?"}
        async def synthesise_speech(self, text):
            return wav_bytes()
    monkeypatch.setattr("app.worker._provider", lambda _: Speech())
    monkeypatch.setattr("app.providers.get_provider", lambda **_: Speech())
    receipt = client.post("/v1/device/turns", content=wav_bytes(), headers={**auth(ids),
        "Content-Type": "audio/wav", "Idempotency-Key": str(uuid4())})
    assert receipt.status_code == 202, receipt.text
    with app.state.db.SessionLocal() as db:
        turn = db.get(m.VoiceTurn, receipt.json()["turn_id"])
        assert turn.vocabulary_version == 1
        assert turn.result["vocabulary"] == {"version": 1, "asr_applied": False}
    assert observed[0] == ("asr", 1, ["Fictional Med A"])
    assert observed[1][1] == "I did not take two tablets of Fictional Med A."
    assert observed[1][2]["terms"][0]["aliases"] == ["Med A"]

    second = client.put(path(ids["patient"]), json={"expected_version": 1, "terms": [
        {"canonical": "Fictional Med B", "aliases": [], "category": "medicine"}]}, headers=headers)
    assert second.status_code == 200
    with app.state.db.SessionLocal() as db:
        db.add(m.MedicationPlanVersion(patient_id=ids["patient"], version=1, timezone="Asia/Singapore",
            source="Fictional checked label", checked_by_user_id=ids["owner"], checked_by_name="Owner",
            checked_at=utcnow(), active=True, medicines=[{"id": "new", "name": "Fictional Med C"}], schedule=[]))
        old_turn = m.VoiceTurn(device_id=ids["device"], patient_id=ids["patient"],
            idempotency_key=str(uuid4()), content_sha256="fixture", status="transcribed",
            transcript="I did not take two tablets of Fictional Med A.", vocabulary_version=1)
        db.add(old_turn); db.commit(); old_id = old_turn.id
    asyncio.run(process_turn(app, old_id))
    assert observed[-1][0] == "interpret"
    assert observed[-1][2]["version"] == 1
    assert observed[-1][2]["terms"][0]["canonical"] == "Fictional Med A"
    with app.state.db.SessionLocal() as db:
        turn = db.get(m.VoiceTurn, old_id)
        assert turn.vocabulary_version == 1
        assert turn.result["vocabulary"]["asr_applied"] is False
