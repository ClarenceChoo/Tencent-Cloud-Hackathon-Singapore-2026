"""Real encoded audio transport with scripted speech; not live-provider/device evidence."""

from datetime import timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select

from app import models as m
from app.providers import parse_interpretation
from app.security import utcnow
from app.services import validate_wav
from conftest import login, wav_bytes
from test_phone_audio import m4a as m4a
from test_phone_identity import approve, enrollment
from test_security_and_care import create_plan


@pytest.fixture
def journey(env, monkeypatch, m4a):
    client, app, ids = env
    created, headers = enrollment(client)
    assert approve(client, ids, created.json()["code"]).status_code == 200

    class Journey:
        transcript = "Fixture care statement"
        interpretation = {"intent": "chat", "spoken_text": "Hello Pat."}
        context = None

        async def transcribe_audio(self, audio):
            validate_wav(audio)
            return self.transcript

        async def interpret_turn(self, transcript, context):
            self.context = context
            return self.interpretation

        async def synthesise_speech(self, text):
            return wav_bytes()

        def speak(
            self, interpretation, *, context=None, transcript="Fixture care statement"
        ):
            self.interpretation, self.transcript = interpretation, transcript
            request_headers = {
                **headers,
                "Idempotency-Key": str(uuid4()),
                "Content-Type": "audio/mp4",
            }
            if context:
                request_headers["X-Context-Id"] = context
            response = client.post(
                "/v1/phone/turns", content=m4a, headers=request_headers
            )
            assert response.status_code == 202, response.text
            result = client.get(
                "/v1/device/turns/" + response.json()["turn_id"], headers=headers
            ).json()
            assert result["event"], result
            return response.json()["turn_id"], result["event"], request_headers

        def propose(self, kind, payload):
            turn, event, _ = self.speak(
                {"intent": "proposal", "kind": kind, "payload": payload}
            )
            assert event["payload"]["status"] == "awaiting_confirmation", event
            proposal = self.home()["current_proposal"]
            assert proposal and proposal["context_id"] == event["payload"]["context_id"]
            return proposal, turn

        def confirm(self, proposal):
            _, event, original_headers = self.speak(
                {"intent": "confirm"},
                context=proposal["context_id"],
                transcript="Yes save that",
            )
            assert event["payload"]["status"] == "committed", event
            assert event["payload"]["spoken_text"] == "Saved."
            # Exact upload retry after commitment never creates another care fact.
            retry = client.post(
                "/v1/phone/turns", content=m4a, headers=original_headers
            )
            assert retry.status_code == 202, retry.text
            return event["payload"]["record_id"]

        def home(self):
            response = client.get("/v1/phone/home", headers=headers)
            assert response.status_code == 200, response.text
            return response.json()

    engine = Journey()
    monkeypatch.setattr("app.worker._provider", lambda _: engine)
    monkeypatch.setattr("app.providers.get_provider", lambda **_: engine)
    return client, app, ids, headers, engine


def assert_phone_source(row, turn):
    source = row["provenance"]
    assert source["type"] == "phone" and source["turn_id"] == turn
    assert source["device_id"] and source["proposal_id"] and source["confirmed_at"]
    assert "credential" not in str(source) and "transcript" not in str(source)


def test_spoken_correction_confirmation_chat_and_source_privacy(journey):
    client, app, ids, headers, voice = journey
    proposal, _ = voice.propose(
        "health_note",
        {
            "wording": "Right knee after walking",
            "share_with_user_ids": [ids["caregiver"]],
        },
    )
    assert voice.home()["notes"] == []
    corrected_turn, _, _ = voice.speak(
        {
            "intent": "correct",
            "payload": {
                "wording": "Left knee after walking",
                "occurrence_text": "after walking",
                "share_with_user_ids": [ids["caregiver"]],
            },
        },
        context=proposal["context_id"],
        transcript="Actually my left knee",
    )
    current = voice.home()["current_proposal"]
    assert current["id"] != proposal["id"]
    assert (
        client.post(
            "/v1/phone/proposals/" + proposal["id"] + "/confirm",
            headers=headers,
            json={"confirmed": True, "context_id": proposal["context_id"]},
        ).status_code
        == 409
    )
    voice.confirm(current)
    note = voice.home()["notes"][0]
    assert note["wording"] == "Left knee after walking"
    assert note["occurred_at"] is None and note["occurrence_text"] == "after walking"
    assert_phone_source(note, corrected_turn)
    voice.speak(
        {
            "intent": "chat",
            "spoken_text": "Hello Pat. What would you like to talk about?",
        }
    )
    _, late, _ = voice.speak({"intent": "confirm"}, transcript="Yes")
    assert late["payload"]["status"] == "clarification_required"
    with app.state.db.SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(m.HealthNote)) == 1
        assert all(
            turn.raw_audio is None for turn in db.scalars(select(m.VoiceTurn)).all()
        )
    login(client, "caregiver@example.invalid", "caregiver-password")
    shared = client.get("/v1/app/patients/" + ids["patient"] + "/dashboard").json()
    assert_phone_source(shared["notes"][0], corrected_turn)
    login(client, "caregiver2@example.invalid", "caregiver2-password")
    hidden = client.get("/v1/app/patients/" + ids["patient"] + "/dashboard").json()
    assert hidden["notes"] == [] and corrected_turn not in str(hidden)


@pytest.mark.parametrize(
    "state",
    ["reported_taken", "reported_skipped", "reported_not_yet", "reported_uncertain"],
)
def test_medication_reports_keep_occurrence_and_confirmation_provenance(journey, state):
    client, app, ids, _, voice = journey
    create_plan(client, ids["patient"], login(client))
    dose = voice.home()["doses"][0]
    assert (
        dose["report_state"] == "unconfirmed"
        and dose["provenance"]["type"] == "unknown"
    )
    payload = {"dose_instance_id": dose["id"], "report_state": state}
    if state == "reported_taken":
        payload["taken_time_text"] = "with breakfast"
    proposal, turn = voice.propose("medication_report", payload)
    assert voice.home()["doses"][0]["report_state"] == "unconfirmed"
    assert voice.confirm(proposal) == dose["id"]
    updated = next(row for row in voice.home()["doses"] if row["id"] == dose["id"])
    assert updated["report_state"] == state
    assert_phone_source(updated, turn)
    assert len(updated["report_history"]) == 1
    assert_phone_source(updated["report_history"][0], turn)


def test_medication_explanations_ignore_model_prose_and_reject_changed_plan_audio(
    journey,
):
    client, app, ids, headers, voice = journey
    create_plan(client, ids["patient"], login(client))
    _, event, _ = voice.speak(
        {
            "intent": "explain",
            "payload": {"medicine_id": "med_one"},
            "spoken_text": "INVENTED INSTRUCTION",
        }
    )
    text = event["payload"]["spoken_text"]
    assert "Reviewed fictional reference" in text and "INVENTED" not in text
    assert (
        client.get(event["payload"]["audio_paths"][0], headers=headers).status_code
        == 200
    )
    create_plan(client, ids["patient"], login(client))
    assert (
        client.get(event["payload"]["audio_paths"][0], headers=headers).status_code
        == 410
    )
    _, unknown, _ = voice.speak(
        {"intent": "explain", "payload": {"medicine_id": "not_in_plan"}}
    )
    assert "could not identify" in unknown["payload"]["spoken_text"]
    assert voice.home()["current_proposal"] is None


def test_external_reading_preserves_units_reported_time_and_separate_device_origin(
    journey,
):
    client, _, ids, _, voice = journey
    proposal, turn = voice.propose(
        "measurement",
        {
            "measurement_type": "blood_pressure",
            "systolic": 125,
            "diastolic": 78,
            "unit": "mmHg",
            "source_description": "Existing home cuff",
            "reporting_actor": "patient",
            "timezone": "Asia/Singapore",
            "occurrence_text": "after breakfast",
        },
    )
    assert voice.home()["measurements"] == []
    voice.confirm(proposal)
    row = voice.home()["measurements"][0]
    assert (row["unit"], row["source_description"], row["occurrence_text"]) == (
        "mmHg",
        "Existing home cuff",
        "after breakfast",
    )
    assert row["occurred_at"] is None
    assert_phone_source(row, turn)
    login(client)
    dashboard = client.get("/v1/app/patients/" + ids["patient"] + "/dashboard").json()
    assert_phone_source(dashboard["measurements"][0], turn)


def test_preventive_history_distinguishes_dashboard_creation_and_phone_transitions(
    journey,
):
    client, _, ids, _, voice = journey
    owner = login(client)
    original = client.post(
        "/v1/app/patients/" + ids["patient"] + "/proposals",
        headers=owner,
        json={
            "kind": "preventive_task",
            "payload": {
                "task_type": "review",
                "description": "Existing care-plan review",
                "source": "Fictional care plan",
                "timezone": "Asia/Singapore",
                "due_date": "2026-10-01",
                "state": "due",
            },
        },
    ).json()
    confirmed = client.post(
        "/v1/app/proposals/" + original["id"] + "/confirm",
        headers=owner,
        json={"confirmed": True},
    )
    assert confirmed.status_code == 200, confirmed.text
    task = voice.home()["preventive_tasks"][0]
    assert task["provenance"]["type"] == "dashboard"
    arranged, arranged_turn = voice.propose(
        "preventive_task",
        {"task_id": task["id"], "state": "arranged", "appointment_date": "2026-10-03"},
    )
    voice.confirm(arranged)
    completed, completed_turn = voice.propose(
        "preventive_task",
        {"task_id": task["id"], "state": "completed", "completion_date": "2026-10-04"},
    )
    voice.confirm(completed)
    current = voice.home()["preventive_tasks"][0]
    assert (
        current["due_date"],
        current["appointment_date"],
        current["completion_date"],
    ) == ("2026-10-01", "2026-10-03", "2026-10-04")
    assert current["source"] == "Fictional care plan"
    assert [t["to_state"] for t in current["transitions"]] == [
        "due",
        "arranged",
        "completed",
    ]
    assert_phone_source(current["transitions"][1], arranged_turn)
    assert_phone_source(current, completed_turn)
    assert current["transitions"][0]["provenance"]["type"] == "dashboard"
    assert (
        client.get("/v1/app/patients/" + ids["patient"] + "/dashboard").json()[
            "preventive_tasks"
        ][0]["transitions"]
        == current["transitions"]
    )


def test_support_status_and_followup_outcome_are_grounded_and_source_linked(journey):
    client, _, ids, headers, voice = journey
    support, support_turn = voice.propose(
        "support_request",
        {
            "request_text": "Please help arrange a refill",
            "recipient_user_id": ids["caregiver_two"],
            "barrier_text": "Transport is difficult",
            "urgency": "urgent",
        },
    )
    assert "does not dispatch" in support["readback"]
    support_id = voice.confirm(support)
    recorded_support = voice.home()["support_requests"][0]
    assert_phone_source(recorded_support, support_turn)
    assert not recorded_support["calling_route_configured"]
    assert "No calling route is configured" in recorded_support["calling_route"]
    status_intent = {
        "intent": "support_status",
        "payload": {"record_id": support_id},
        "spoken_text": "A caregiver has already resolved everything",
    }
    assert (
        parse_interpretation(__import__("json").dumps(status_intent))["intent"]
        == "support_status"
    )
    _, unacknowledged, _ = voice.speak(status_intent)
    assert "has not acknowledged" in unacknowledged["payload"]["spoken_text"]
    caregiver = login(client, "caregiver2@example.invalid", "caregiver2-password")
    assert (
        client.post(
            "/v1/app/support-requests/" + support_id + "/acknowledge", headers=caregiver
        ).status_code
        == 200
    )
    assert (
        client.get(
            unacknowledged["payload"]["audio_paths"][0], headers=headers
        ).status_code
        == 410
    )
    _, acknowledged, _ = voice.speak(status_intent)
    assert "has acknowledged" in acknowledged["payload"]["spoken_text"]
    followup, created_turn = voice.propose(
        "followup",
        {
            "related_type": "support_request",
            "related_id": support_id,
            "check_at": (utcnow() + timedelta(hours=1)).isoformat(),
            "permission_scope": "related_recipients",
        },
    )
    followup_id = voice.confirm(followup)
    assert (
        client.post(
            "/v1/app/support-requests/" + support_id + "/resolve",
            headers=caregiver,
            json={"outcome": "Caregiver reports a refill was arranged"},
        ).status_code
        == 200
    )
    _, resolved, _ = voice.speak(status_intent)
    assert (
        "Caregiver reports a refill was arranged" in resolved["payload"]["spoken_text"]
    )
    assert any(
        s["id"] == support_id and s["status"] == "resolved"
        for s in voice.context["support_requests"]
    )
    outcome, outcome_turn = voice.propose(
        "followup",
        {
            "followup_id": followup_id,
            "resolution_state": "resolved",
            "reported_outcome": "The medicine has been collected",
        },
    )
    voice.confirm(outcome)
    row = voice.home()["followups"][0]
    assert_phone_source(row, created_turn)
    assert_phone_source(row["resolutions"][0], outcome_turn)
    _, answered, _ = voice.speak(
        {"intent": "followup_status", "payload": {"record_id": followup_id}}
    )
    assert "The medicine has been collected" in answered["payload"]["spoken_text"]
    _, unknown, _ = voice.speak(
        {"intent": "support_status", "payload": {"record_id": "support_other_patient"}}
    )
    assert unknown["payload"]["status"] == "clarification_required"
    login(client, "caregiver@example.invalid", "caregiver-password")
    hidden = client.get("/v1/app/patients/" + ids["patient"] + "/dashboard").json()
    assert hidden["support_requests"] == [] and hidden["followups"] == []
    assert support_turn not in str(hidden) and outcome_turn not in str(hidden)


def test_phone_sources_feed_reviewed_summary_with_omission_expiry_and_revocation(
    journey,
):
    client, app, ids, headers, voice = journey
    proposal, _ = voice.propose("health_note", {"wording": "Private fictional concern"})
    note_id = voice.confirm(proposal)
    proposal, _ = voice.propose(
        "measurement",
        {
            "measurement_type": "blood_pressure",
            "systolic": 125,
            "diastolic": 78,
            "unit": "mmHg",
            "source_description": "Existing cuff",
            "reporting_actor": "patient",
            "timezone": "Asia/Singapore",
            "occurrence_text": "this morning",
        },
    )
    reading_id = voice.confirm(proposal)
    day = utcnow().astimezone(ZoneInfo("Asia/Singapore")).date().isoformat()
    client.cookies.clear()
    assert (
        client.post(
            "/v1/app/patients/" + ids["patient"] + "/summaries",
            headers=headers,
            json={"start_date": day, "end_date": day},
        ).status_code
        == 401
    )
    owner = login(client)
    summary = client.post(
        "/v1/app/patients/" + ids["patient"] + "/summaries",
        headers=owner,
        json={"start_date": day, "end_date": day},
    ).json()
    assert {ref["id"] for ref in summary["sources"]} == {note_id, reading_id}
    url = "/v1/app/summaries/" + summary["id"]
    assert (
        client.post(
            url + "/share", headers=owner, json={"expires_in_seconds": 60}
        ).status_code
        == 409
    )
    reviewed = client.put(
        url,
        headers=owner,
        json={
            "sections": summary["sections"],
            "omitted_source_ids": [note_id],
            "reviewed": True,
        },
    )
    assert reviewed.status_code == 200, reviewed.text
    shared = client.post(
        url + "/share", headers=owner, json={"expires_in_seconds": 60}
    ).json()
    public = client.get(shared["url"])
    assert (
        public.status_code == 200
        and "Private fictional concern" not in public.text
        and note_id not in public.text
    )
    assert reading_id in public.text
    assert client.post(url + "/revoke", headers=owner).status_code == 200
    assert client.get(shared["url"]).status_code == 410

    expiring = client.post(
        url + "/share", headers=owner, json={"expires_in_seconds": 60}
    ).json()
    with app.state.db.SessionLocal() as db:
        for link in db.scalars(
            select(m.SummaryShare).where(
                m.SummaryShare.summary_id == summary["id"],
                m.SummaryShare.revoked_at.is_(None),
            )
        ):
            link.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert client.get(expiring["url"]).status_code == 410


def test_head_revalidates_owned_unexpired_context_without_replaying_audio(journey):
    client, app, ids, headers, voice = journey
    proposal, turn = voice.propose("health_note", {"wording": "Fictional concern"})
    event = client.get("/v1/device/turns/" + turn, headers=headers).json()["event"]
    path = event["payload"]["audio_paths"][0]
    original = client.get(path, headers=headers)
    checked = client.head(path, headers=headers)
    assert checked.status_code == 200 and checked.content == b""
    assert checked.headers["content-length"] == str(len(original.content))
    assert checked.headers["cache-control"] == "private, no-store"
    assert client.head(path).status_code == 401
    assert client.head(path, headers={"Authorization": "Bearer " + ids["credential"]}).status_code == 404
    voice.confirm(proposal)
    assert client.head(path, headers=headers).status_code == 410
    _, reply, _ = voice.speak({"intent": "chat", "spoken_text": "Hello Pat"})
    current = reply["payload"]["audio_paths"][0]
    with app.state.db.SessionLocal() as db:
        asset = db.get(m.AudioAsset, current.rsplit("/", 1)[1])
        asset.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    assert client.head(current, headers=headers).status_code == 410
    owner = login(client)
    device = voice.home()["device_id"]
    assert client.post("/v1/app/devices/" + device + "/revoke", headers=owner).status_code == 200
    assert client.head(current, headers=headers).status_code == 403


def test_head_invalidates_changed_plan_and_support_status(journey):
    client, _, ids, headers, voice = journey
    create_plan(client, ids["patient"], login(client))
    _, explanation, _ = voice.speak({"intent": "explain", "payload": {"medicine_id": "med_one"}})
    plan_audio = explanation["payload"]["audio_paths"][0]
    assert client.head(plan_audio, headers=headers).status_code == 200
    create_plan(client, ids["patient"], login(client))
    assert client.head(plan_audio, headers=headers).status_code == 410
    proposal, _ = voice.propose("support_request", {"request_text": "Fictional request", "recipient_user_id": ids["caregiver"]})
    support_id = voice.confirm(proposal)
    _, status, _ = voice.speak({"intent": "support_status", "payload": {"record_id": support_id}})
    status_audio = status["payload"]["audio_paths"][0]
    assert client.head(status_audio, headers=headers).status_code == 200
    caregiver = login(client, "caregiver@example.invalid", "caregiver-password")
    assert client.post("/v1/app/support-requests/" + support_id + "/acknowledge", headers=caregiver).status_code == 200
    assert client.head(status_audio, headers=headers).status_code == 410
