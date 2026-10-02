"""Purpose templates preserve provenance and separate authored questions."""

from copy import deepcopy
from datetime import datetime, timezone

import pytest

from app.summary_templates import SUMMARY_TEMPLATE_VERSION, present_summary
from conftest import login


EVIDENCE = [
    {"title": "Reported health notes", "items": [{"text": "Patient reported: knee pain (occurrence time unknown).", "source_id": "note_a"}]},
    {"title": "Reported measurements", "items": [{"text": "Patient reported 128/76.", "source_id": "measure_b"}]},
    {"title": "Medication reports", "items": [{"text": "Dose was not reported.", "source_id": "dose_c"}]},
    {"title": "Current preventive care context at summary generation", "items": [{"text": "Screening is currently due.", "source_id": "task_d"}]},
    {"title": "Unresolved support and follow-up", "items": [{"text": "Follow-up remains open.", "source_id": "followup_e"}]},
]


@pytest.mark.parametrize("purpose,first_source", [
    ("doctor_visit", "note_a"),
    ("family_handoff", "followup_e"),
    ("weekly_review", "note_a"),
])
def test_purpose_presentation_preserves_all_evidence(purpose, first_source):
    original = deepcopy(EVIDENCE)
    presented = present_summary(purpose, EVIDENCE, [])
    original_items = {item["source_id"]: item for section in EVIDENCE for item in section["items"]}
    presented_items = {item["source_id"]: item for section in presented for item in section["items"]}
    assert presented_items == original_items
    assert presented[0]["items"][0]["source_id"] == first_source
    assert "outside" in next(section["title"] for section in presented if section["items"][0]["source_id"] == "task_d")
    assert EVIDENCE == original
    assert SUMMARY_TEMPLATE_VERSION == 1


def test_authored_questions_have_no_source_and_no_actor_identifier_in_section():
    question = {
        "text": "Was there an unrecorded fall?",
        "author_id": "user_private_id",
        "author_display_name": "Caregiver",
        "authored_at": datetime(2026, 10, 2, 8, tzinfo=timezone.utc),
    }
    presented = present_summary("doctor_visit", EVIDENCE, [question])
    authored = presented[-1]
    assert authored["kind"] == "authored_questions"
    assert authored["items"] == [{
        "text": question["text"],
        "author_display_name": "Caregiver",
        "authored_at": "2026-10-02T08:00:00+00:00",
    }]
    assert "source_id" not in authored["items"][0]
    assert "author_id" not in str(authored)
    assert all(question["text"] not in item["text"] for section in presented[:-1] for item in section["items"])


def test_unknown_evidence_sections_are_preserved_without_rewriting():
    extra = {"title": "Future evidence", "items": [{"text": "Original wording", "source_id": "future_f"}]}
    assert present_summary("family_handoff", [extra], []) == [extra]
    with pytest.raises(ValueError):
        present_summary("unlisted", EVIDENCE, [])


def test_create_defaults_to_doctor_visit_and_preserves_date_scope(env):
    client, _app, ids = env
    headers = login(client)
    summary = client.post(
        f"/v1/app/patients/{ids['patient']}/summaries",
        json={"start_date": "2026-10-01", "end_date": "2026-10-02"}, headers=headers,
    )
    assert summary.status_code == 201, summary.text
    assert summary.json()["purpose"] == "doctor_visit"
    assert summary.json()["template_version"] == 1
    assert summary.json()["questions"] == []


def test_all_purposes_preserve_source_ids_and_versions_across_generation(env):
    client, _app, ids = env
    headers = login(client)
    proposed = client.post(
        f"/v1/app/patients/{ids['patient']}/proposals",
        json={"kind": "health_note", "payload": {"wording": "Fictional knee pain", "occurrence_text": "time unknown"}},
        headers=headers,
    )
    assert proposed.status_code == 201, proposed.text
    confirmed = client.post(f"/v1/app/proposals/{proposed.json()['id']}/confirm", json={"confirmed": True}, headers=headers)
    assert confirmed.status_code == 200, confirmed.text
    results = []
    for purpose in ("doctor_visit", "family_handoff", "weekly_review"):
        response = client.post(
            f"/v1/app/patients/{ids['patient']}/summaries",
            json={"start_date": "2026-10-01", "end_date": "2026-10-03", "purpose": purpose},
            headers=headers,
        )
        assert response.status_code == 201, response.text
        results.append(response.json())
    assert all(row["purpose"] in ("doctor_visit", "family_handoff", "weekly_review") for row in results)
    assert all(row["template_version"] == 1 for row in results)
    assert all({(ref["id"], ref["version"]) for ref in row["sources"]} ==
               {(ref["id"], ref["version"]) for ref in results[0]["sources"]} for row in results)
    assert any("time unknown" in item["text"]
               for section in results[0]["sections"] for item in section["items"])


def test_out_of_period_report_is_filtered_but_current_context_is_labelled(env):
    client, _app, ids = env
    headers = login(client)
    note = client.post(
        f"/v1/app/patients/{ids['patient']}/proposals",
        json={"kind": "health_note", "payload": {"wording": "Fictional old event",
                                                "occurred_at": "2020-01-01T08:00:00Z", "timezone": "Asia/Singapore"}},
        headers=headers,
    )
    assert note.status_code == 201, note.text
    note_id = client.post(f"/v1/app/proposals/{note.json()['id']}/confirm",
                          json={"confirmed": True}, headers=headers).json()["record_id"]
    task = client.post(
        f"/v1/app/patients/{ids['patient']}/proposals",
        json={"kind": "preventive_task", "payload": {"task_type": "screening", "description": "Fictional screening",
             "source": "Fictional care plan", "due_date": "2020-01-01", "timezone": "Asia/Singapore", "state": "due"}},
        headers=headers,
    )
    assert task.status_code == 201, task.text
    task_id = client.post(f"/v1/app/proposals/{task.json()['id']}/confirm",
                          json={"confirmed": True}, headers=headers).json()["record_id"]
    summary = client.post(
        f"/v1/app/patients/{ids['patient']}/summaries",
        json={"start_date": "2026-10-01", "end_date": "2026-10-03", "purpose": "weekly_review"},
        headers=headers,
    ).json()
    assert note_id not in {ref["id"] for ref in summary["sources"]}
    assert task_id in {ref["id"] for ref in summary["sources"]}
    context = next(section for section in summary["sections"] if any(item.get("source_id") == task_id for item in section["items"]))
    assert "outside the selected period" in context["title"]


@pytest.mark.parametrize("questions", [["x" * 501], ["question"] * 11])
def test_question_limits_apply_to_client_text(env, questions):
    client, _app, ids = env
    headers = login(client)
    response = client.post(
        f"/v1/app/patients/{ids['patient']}/summaries",
        json={"start_date": "2026-10-01", "end_date": "2026-10-02", "questions": questions}, headers=headers,
    )
    assert response.status_code == 422, response.text
