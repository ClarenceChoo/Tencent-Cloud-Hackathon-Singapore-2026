"""Regression coverage for the September project audit, using real API transactions."""
from datetime import timedelta

import pytest
from sqlalchemy import select

from app import models as m
from app.security import utcnow
from app.services import commit_proposal
from app.worker import _context
from conftest import login
from test_security_and_care import create_plan


def propose(client, ids, headers, kind, payload):
    response = client.post(f'/v1/app/patients/{ids["patient"]}/proposals',
                           json={'kind': kind, 'payload': payload}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def confirm(client, headers, proposal):
    return client.post(f'/v1/app/proposals/{proposal["id"]}/confirm',
                       json={'confirmed': True}, headers=headers)


def shared_note(client, ids, headers):
    proposal = propose(client, ids, headers, 'health_note',
                       {'wording': 'Fictional private care detail', 'share_with_user_ids': [ids['caregiver_two']]})
    response = confirm(client, headers, proposal)
    assert response.status_code == 200, response.text
    return response.json()['record_id']


def followup(client, ids, headers, note_id, scope='related_recipients'):
    return propose(client, ids, headers, 'followup', {
        'related_type': 'health_note', 'related_id': note_id,
        'check_at': '2030-01-01T09:00:00+08:00', 'permission_scope': scope})


def revoke_note_access(client, headers, note_id):
    response = client.put(f'/v1/app/notes/{note_id}/sharing', json={'user_ids': []}, headers=headers)
    assert response.status_code == 200, response.text


@pytest.mark.parametrize('revoked', [False, True])
def test_note_deletion_requires_current_record_access(env, revoked):
    client, app, ids = env
    owner_headers = login(client)
    note_id = shared_note(client, ids, owner_headers)
    if revoked:
        revoke_note_access(client, owner_headers, note_id)
    headers = login(client, 'caregiver2@example.invalid', 'caregiver2-password')
    response = client.delete(f'/v1/app/notes/{note_id}', headers=headers)
    assert response.status_code == (403 if revoked else 204), response.text
    with app.state.db.SessionLocal() as db:
        assert bool(db.get(m.HealthNote, note_id).deleted_at) is not revoked


@pytest.mark.parametrize('operation', ['create', 'resolve'])
@pytest.mark.parametrize('change', ['unshare', 'delete', 'expire_recipient', 'revoke_recipient'])
def test_followup_confirmation_rechecks_source_and_recipients(env, operation, change):
    client, app, ids = env
    headers = login(client)
    note_id = shared_note(client, ids, headers)
    pending = followup(client, ids, headers, note_id)
    followup_id = None
    if operation == 'resolve':
        response = confirm(client, headers, pending)
        assert response.status_code == 200, response.text
        followup_id = response.json()['record_id']
        pending = propose(client, ids, headers, 'followup', {
            'followup_id': followup_id, 'resolution_state': 'resolved', 'reported_outcome': 'A human reported improvement'})
    if change == 'unshare':
        revoke_note_access(client, headers, note_id)
    elif change == 'delete':
        assert client.delete(f'/v1/app/notes/{note_id}', headers=headers).status_code == 204
    else:
        with app.state.db.SessionLocal() as db:
            grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.user_id == ids['caregiver_two']))
            grant_id = grant.id
            if change == 'expire_recipient':
                grant.expires_at = utcnow() - timedelta(seconds=1)
                db.commit()
        if change == 'revoke_recipient':
            assert client.delete(f'/v1/app/grants/{grant_id}', headers=headers).status_code == 204
    response = confirm(client, headers, pending)
    assert response.status_code == 409, response.text
    with app.state.db.SessionLocal() as db:
        assert db.get(m.ConfirmationProposal, pending['id']).status == 'invalidated'
        if followup_id:
            assert db.get(m.FollowUp, followup_id).resolution_state == 'open'
        else:
            assert db.scalar(select(m.FollowUp).where(m.FollowUp.proposal_id == pending['id'])) is None


@pytest.mark.parametrize('scope', ['private', 'related_recipients'])
def test_unchanged_followup_can_be_created_and_resolved(env, scope):
    client, app, ids = env
    headers = login(client)
    note_id = shared_note(client, ids, headers)
    pending = followup(client, ids, headers, note_id, scope)
    created = confirm(client, headers, pending)
    assert created.status_code == 200, created.text
    pending = propose(client, ids, headers, 'followup', {
        'followup_id': created.json()['record_id'], 'resolution_state': 'resolved', 'reported_outcome': 'Reported better'})
    response = confirm(client, headers, pending)
    assert response.status_code == 200, response.text


def test_private_followup_cannot_be_confirmed_after_creator_loses_source_access(env):
    client, app, ids = env
    headers = login(client)
    note_id = shared_note(client, ids, headers)
    caregiver_headers = login(client, 'caregiver2@example.invalid', 'caregiver2-password')
    pending = followup(client, ids, caregiver_headers, note_id, 'private')
    headers = login(client)
    revoke_note_access(client, headers, note_id)
    caregiver_headers = login(client, 'caregiver2@example.invalid', 'caregiver2-password')
    assert confirm(client, caregiver_headers, pending).status_code == 409


def test_owner_grant_cannot_be_downgraded_but_caregiver_can_be_updated(env):
    client, app, ids = env
    headers = login(client)
    url = f'/v1/app/patients/{ids["patient"]}/grants'
    response = client.post(url, json={'user_id': ids['owner'], 'scopes': ['read:dashboard']}, headers=headers)
    assert response.status_code == 409, response.text
    with app.state.db.SessionLocal() as db:
        grant = db.scalar(select(m.AccessGrant).where(m.AccessGrant.user_id == ids['owner']))
        assert grant.scopes == ['*'] and grant.revoked_at is None
    response = client.post(url, json={'user_id': ids['caregiver'], 'scopes': ['read:dashboard', 'write:care']}, headers=headers)
    assert response.status_code == 201, response.text


def dose_id_for_plan(client, app, ids, headers):
    plan = create_plan(client, ids['patient'], headers)
    with app.state.db.SessionLocal() as db:
        return db.scalar(select(m.DoseInstance.id).where(m.DoseInstance.plan_id == plan['id']))


@pytest.mark.parametrize('initial', ['reported_not_yet', 'reported_uncertain'])
def test_provisional_report_can_progress_with_fresh_review_and_retains_history(env, initial):
    client, app, ids = env
    headers = login(client)
    dose_id = dose_id_for_plan(client, app, ids, headers)
    first = propose(client, ids, headers, 'medication_report', {'dose_instance_id': dose_id, 'report_state': initial})
    assert confirm(client, headers, first).status_code == 200
    # Voice must still be able to identify this dose after a provisional answer.
    with app.state.db.SessionLocal() as db:
        context = _context(db, db.get(m.Device, ids['device']), None)
        assert dose_id in {dose['id'] for dose in context['doses']}
    second = propose(client, ids, headers, 'medication_report', {
        'dose_instance_id': dose_id, 'report_state': 'reported_taken', 'taken_time_text': 'after breakfast'})
    assert initial.removeprefix('reported_').replace('_', ' ') in second['readback']
    assert confirm(client, headers, second).status_code == 200
    # A retry of the old confirmation must not restore its old provisional state.
    assert confirm(client, headers, first).status_code == 200
    assert confirm(client, headers, second).status_code == 200
    dashboard = client.get(f'/v1/app/patients/{ids["patient"]}/dashboard').json()
    dose = next(dose for dose in dashboard['doses'] if dose['id'] == dose_id)
    assert dose['report_state'] == 'reported_taken'
    assert [report['report_state'] for report in dose['report_history']] == [initial, 'reported_taken']


def test_competing_medication_proposals_cannot_overwrite_an_intervening_report(env):
    client, app, ids = env
    headers = login(client)
    dose_id = dose_id_for_plan(client, app, ids, headers)
    first = propose(client, ids, headers, 'medication_report', {'dose_instance_id': dose_id, 'report_state': 'reported_uncertain'})
    stale = propose(client, ids, headers, 'medication_report', {'dose_instance_id': dose_id, 'report_state': 'reported_taken'})
    assert confirm(client, headers, first).status_code == 200
    assert confirm(client, headers, stale).status_code == 409
    fresh = propose(client, ids, headers, 'medication_report', {'dose_instance_id': dose_id, 'report_state': 'reported_not_yet'})
    competing = propose(client, ids, headers, 'medication_report', {'dose_instance_id': dose_id, 'report_state': 'reported_taken'})
    assert confirm(client, headers, fresh).status_code == 200
    assert confirm(client, headers, competing).status_code == 409


def test_terminal_medication_report_is_not_overwritten(env):
    client, app, ids = env
    headers = login(client)
    dose_id = dose_id_for_plan(client, app, ids, headers)
    first = propose(client, ids, headers, 'medication_report', {'dose_instance_id': dose_id, 'report_state': 'reported_taken'})
    assert confirm(client, headers, first).status_code == 200
    response = client.post(f'/v1/app/patients/{ids["patient"]}/proposals', json={'kind': 'medication_report',
        'payload': {'dose_instance_id': dose_id, 'report_state': 'reported_skipped'}}, headers=headers)
    assert response.status_code == 409, response.text


def test_repeated_confirmation_refreshes_preloaded_session(env):
    client, app, ids = env
    headers = login(client)
    pending = propose(client, ids, headers, 'health_note', {'wording': 'One confirmed note'})
    with app.state.db.SessionLocal() as stale_db:
        stale = stale_db.get(m.ConfirmationProposal, pending['id'])
        assert stale.status == 'pending'
        first = confirm(client, headers, pending)
        assert first.status_code == 200
        result = commit_proposal(stale_db, pending['id'], ids['patient'])
        stale_db.commit()
        assert result.record_id == first.json()['record_id']
        assert len(stale_db.scalars(select(m.HealthNote).where(m.HealthNote.proposal_id == pending['id'])).all()) == 1


@pytest.mark.parametrize('operation', ['create', 'revise', 'confirm'])
@pytest.mark.parametrize('change', ['revoke', 'downgrade'])
def test_proposal_write_rechecks_actor_after_waiting_for_patient_lock(env, monkeypatch, operation, change):
    from app import main, routing

    client, app, ids = env
    headers = login(client, 'caregiver2@example.invalid', 'caregiver2-password')
    pending = propose(client, ids, headers, 'health_note', {'wording': 'Pending report'})
    original = main.grant_scopes
    changed = False

    def change_access_after_initial_check(db, user_id, patient_id):
        nonlocal changed
        result = original(db, user_id, patient_id)
        if not changed:
            changed = True
            # Deterministically interleave a committed change after the route
            # reads authorization but before it acquires its write lock.
            with app.state.db.SessionLocal() as other:
                routing.lock_patient(other, patient_id)
                grant = other.scalar(select(m.AccessGrant).where(m.AccessGrant.patient_id == patient_id,
                                                                m.AccessGrant.user_id == user_id))
                if change == 'revoke':
                    grant.revoked_at = utcnow()
                else:
                    grant.scopes = ['read:dashboard']
                other.commit()
        return result

    monkeypatch.setattr(main, 'grant_scopes', change_access_after_initial_check)
    if operation == 'create':
        response = client.post(f'/v1/app/patients/{ids["patient"]}/proposals', headers=headers,
                               json={'kind': 'health_note', 'payload': {'wording': 'Must not be proposed'}})
    elif operation == 'revise':
        response = client.post(f'/v1/app/proposals/{pending["id"]}/revise', headers=headers,
                               json={'payload': {'wording': 'Must not be revised'}})
    else:
        response = confirm(client, headers, pending)
    assert changed
    assert response.status_code == 403, response.text
    with app.state.db.SessionLocal() as db:
        proposals = db.scalars(select(m.ConfirmationProposal).where(m.ConfirmationProposal.patient_id == ids['patient'])).all()
        assert len(proposals) == 1 and proposals[0].status == 'pending'
        assert db.scalar(select(m.HealthNote).where(m.HealthNote.patient_id == ids['patient'])) is None


@pytest.mark.parametrize('resolver', ['owner', 'device'])
def test_medication_followup_keeps_original_private_audience_when_another_actor_resolves(env, resolver):
    from app.services import create_proposal

    client, app, ids = env
    headers = login(client)
    dose_id = dose_id_for_plan(client, app, ids, headers)
    headers = login(client, 'caregiver2@example.invalid', 'caregiver2-password')
    pending = propose(client, ids, headers, 'followup', {
        'related_type': 'medication_report', 'related_id': dose_id,
        'check_at': '2030-01-01T09:00:00+08:00', 'permission_scope': 'related_recipients'})
    created = confirm(client, headers, pending)
    assert created.status_code == 200, created.text
    followup_id = created.json()['record_id']
    payload = {'followup_id': followup_id, 'resolution_state': 'resolved', 'reported_outcome': 'A human reported a status update'}
    if resolver == 'owner':
        headers = login(client)
        response = client.post(f'/v1/app/patients/{ids["patient"]}/proposals', headers=headers,
                               json={'kind': 'followup', 'payload': payload})
        assert response.status_code == 201, response.text
        assert confirm(client, headers, response.json()).status_code == 200
    else:
        with app.state.db.SessionLocal() as db:
            proposal = create_proposal(db, ids['patient'], 'followup', payload)
            db.commit()
            commit_proposal(db, proposal.id, ids['patient'])
            db.commit()
    with app.state.db.SessionLocal() as db:
        result = db.get(m.FollowUp, followup_id)
        assert result.resolution_state == 'resolved'
        assert result.permitted_user_ids == [ids['caregiver_two']]
