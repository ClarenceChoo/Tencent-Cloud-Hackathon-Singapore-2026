import os
from uuid import uuid4

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app import migrate


@pytest.fixture
def legacy(tmp_path):
    url = os.getenv('CARELOOP_TEST_DATABASE_URL')
    admin = None
    if url:
        parsed = make_url(url).difference_update_query(['options'])
        admin = create_engine(parsed)
        schema = 'migration_test_' + uuid4().hex
        with admin.begin() as c:
            c.execute(text('CREATE SCHEMA "' + schema + '"'))
        engine = create_engine(parsed.update_query_dict({'options': '-csearch_path=' + schema}))
    else:
        engine = create_engine('sqlite:///' + str(tmp_path / 'legacy.db'))
    migrate.upgrade(engine, migrate.BASELINE)
    with engine.begin() as c:
        c.execute(text('DROP TABLE alembic_version'))
        for patient in ('single', 'multiple', 'none'):
            c.execute(text('INSERT INTO patients (id,name,timezone,language,daily_check_in_enabled) VALUES (:id,:name,:tz,:lang,:enabled)'),
                      {'id': patient, 'name': 'Preserved patient', 'tz': 'Asia/Singapore', 'lang': 'en', 'enabled': False})
        for device, patient in [('d1', 'single'), ('d2', 'multiple'), ('d3', 'multiple')]:
            c.execute(text("INSERT INTO devices (id,credential_hash,credential_version,patient_id,capabilities) VALUES (:id,:hash,1,:patient,:caps)"),
                      {'id': device, 'hash': 'hash-' + device, 'patient': patient, 'caps': '[]'})
        c.execute(text("INSERT INTO confirmation_proposals (id,patient_id,kind,payload,readback,context_id,status,created_at,expires_at) VALUES ('p1','single','health_note','{}','Preserved note','ctx1','committed',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
        c.execute(text("INSERT INTO health_notes (id,patient_id,wording,proposal_id,shared_with_user_ids,created_at,version) VALUES ('n1','single','Preserved note','p1','[]',CURRENT_TIMESTAMP,1)"))
    try:
        yield engine
    finally:
        engine.dispose()
        if admin:
            with admin.begin() as c:
                c.execute(text('DROP SCHEMA "' + schema + '" CASCADE'))
            admin.dispose()


def test_populated_legacy_upgrade_backfills_only_unambiguous_route(legacy):
    migrate.upgrade(legacy)
    migrate.upgrade(legacy)
    with legacy.connect() as c:
        assert c.execute(text('SELECT wording FROM health_notes')).scalar_one() == 'Preserved note'
        assert c.execute(text('SELECT credential_hash FROM devices WHERE id=\'d1\'')).scalar_one() == 'hash-d1'
        routes = dict(c.execute(text('SELECT patient_id,active_device_id FROM companion_routes')).all())
        assert routes == {'single': 'd1', 'multiple': None, 'none': None}
        assert c.execute(text("SELECT COUNT(*) FROM devices WHERE device_type='pendant'")).scalar_one() == 3


def test_vocabulary_migration_adds_snapshot_and_preserves_review_audit(legacy):
    migrate.upgrade(legacy, '0005_capture_intent')
    assert 'care_vocabularies' not in inspect(legacy).get_table_names()
    migrate.upgrade(legacy)
    tables = set(inspect(legacy).get_table_names())
    assert {'care_vocabularies', 'care_vocabulary_audits'} <= tables
    assert 'vocabulary_version' in {column['name'] for column in inspect(legacy).get_columns('voice_turns')}
    with legacy.begin() as c:
        c.execute(text("INSERT INTO users (id,name,email,role,password_hash,active) VALUES ('reviewer','Reviewer','reviewer@example.invalid','owner','fixture',true)"))
        c.execute(text("INSERT INTO care_vocabularies (patient_id,version,terms,reviewed_by_user_id,reviewed_at) VALUES ('single',1,'[]','reviewer',CURRENT_TIMESTAMP)"))
        c.execute(text("INSERT INTO care_vocabulary_audits (patient_id,version,terms,reviewed_by_user_id,reviewed_at) VALUES ('single',1,'[]','reviewer',CURRENT_TIMESTAMP)"))
    with pytest.raises(RuntimeError, match='destroy review history'):
        with legacy.begin() as c:
            command.downgrade(migrate.configuration(c), '0005_capture_intent')
    with legacy.connect() as c:
        assert c.execute(text('SELECT COUNT(*) FROM care_vocabulary_audits')).scalar_one() == 1


def test_summary_purpose_migration_preserves_legacy_review(legacy):
    migrate.upgrade(legacy, '0006_care_vocabulary')
    with legacy.begin() as c:
        c.execute(text("INSERT INTO users (id,name,email,role,password_hash,active) VALUES ('reviewer','Reviewer','reviewer@example.invalid','owner','fixture',true)"))
        c.execute(text("INSERT INTO visit_summaries (id,patient_id,start_date,end_date,sections,source_refs,omitted_source_ids,status,created_by_user_id,created_at) VALUES ('summary_legacy','single','2026-09-01','2026-09-30','[]','[]','[]','reviewed','reviewer',CURRENT_TIMESTAMP)"))
    migrate.upgrade(legacy)
    with legacy.connect() as c:
        row = c.execute(text("SELECT purpose,template_version,questions,sections,status FROM visit_summaries WHERE id='summary_legacy'")).one()
        assert row.purpose == 'doctor_visit'
        assert row.template_version == 1
        assert row.questions == '[]' or row.questions == []
        assert row.sections == '[]' or row.sections == []
        assert row.status == 'reviewed'
    with legacy.begin() as c:
        c.execute(text("UPDATE visit_summaries SET purpose='family_handoff' WHERE id='summary_legacy'"))
    with pytest.raises(RuntimeError, match='discard reviewed content'):
        with legacy.begin() as c:
            command.downgrade(migrate.configuration(c), '0006_care_vocabulary')


def test_capture_intent_migration_preserves_older_turns(legacy):
    migrate.upgrade(legacy, '0004_phone_notifications')
    with legacy.begin() as c:
        c.execute(text("INSERT INTO voice_turns (id,device_id,patient_id,idempotency_key,content_sha256,received_at,status) VALUES ('turn_legacy','d1','single','legacy-key','digest',CURRENT_TIMESTAMP,'completed')"))
    migrate.upgrade(legacy)
    with legacy.connect() as c:
        assert 'capture_intent' in {column['name'] for column in inspect(c).get_columns('voice_turns')}
        assert c.execute(text("SELECT capture_intent FROM voice_turns WHERE id='turn_legacy'")).scalar_one() is None


def test_failed_upgrade_rolls_back_schema_data_and_stamp(legacy, monkeypatch):
    original = command.upgrade
    def failed(config, revision):
        original(config, revision)
        raise RuntimeError('Injected upgrade failure')
    monkeypatch.setattr(command, 'upgrade', failed)
    with pytest.raises(RuntimeError, match='Injected'):
        migrate.upgrade(legacy)
    with legacy.connect() as c:
        assert 'phone_enrollments' not in inspect(c).get_table_names()
        assert 'alembic_version' not in inspect(c).get_table_names()
        assert 'device_type' not in {col['name'] for col in inspect(c).get_columns('devices')}
        assert c.execute(text('SELECT wording FROM health_notes')).scalar_one() == 'Preserved note'
    monkeypatch.setattr(command, 'upgrade', original)
    migrate.upgrade(legacy)


def test_partial_legacy_database_is_not_stamped(legacy):
    with legacy.begin() as c:
        c.execute(text('ALTER TABLE devices DROP COLUMN firmware_version'))
    with pytest.raises(RuntimeError, match='Incomplete legacy schema'):
        migrate.upgrade(legacy)
    with legacy.connect() as c:
        assert 'alembic_version' not in inspect(c).get_table_names()


def test_downgrade_preserves_care_and_revokes_new_phone_credentials(legacy):
    migrate.upgrade(legacy)
    with legacy.begin() as c:
        c.execute(text("UPDATE devices SET device_type='phone' WHERE id='d3'"))
        command.downgrade(migrate.configuration(c), migrate.BASELINE)
    with legacy.connect() as c:
        assert c.execute(text('SELECT wording FROM health_notes')).scalar_one() == 'Preserved note'
        assert c.execute(text("SELECT revoked_at FROM devices WHERE id='d3'")).scalar_one() is not None
    migrate.upgrade(legacy)


def populate_legacy_delivery(engine):
    from datetime import timedelta
    from sqlalchemy import MetaData
    from app.security import utcnow
    from conftest import wav_bytes
    now = utcnow()
    tables = MetaData(); tables.reflect(bind=engine)
    with engine.begin() as c:
        def add(table, **values): c.execute(tables.tables[table].insert().values(**values))
        add('users',id='owner',name='Owner',email='fixture@example.invalid',role='owner',password_hash='fixture',active=True)
        add('medication_plan_versions',id='plan',patient_id='single',version=1,timezone='Asia/Singapore',source='Fictional',checked_by_user_id='owner',checked_by_name='Owner',checked_at=now,active=True,medicines=[],schedule=[])
        add('dose_instances',id='dose',patient_id='single',plan_id='plan',plan_version=1,medicine_id='fixture',medicine_name='Fictional',scheduled_at=now,report_state='unconfirmed')
        add('audio_assets',id='audio',device_id='d1',wav_bytes=wav_bytes(),content_sha256='fixture',duration_ms=400,created_at=now,expires_at=now+timedelta(minutes=2))
        add('reminder_commands',id='cmd_legacy',event_id='evt_legacy',device_id='d1',dose_instance_id='dose',plan_version=1,context_id='ctx_legacy',audio_asset_id='audio',delivery_state='queued',created_at=now,expires_at=now+timedelta(minutes=2))
        add('reminder_acks',id='ackrow',ack_id=str(uuid4()),device_id='d1',command_id='cmd_legacy',stage='received',received_at=now)
        add('checkin_deliveries',id='checkin_legacy',event_id='evt_checkin',device_id='d1',patient_id='single',local_date=now.date(),context_id='ctx_checkin',greeting_text='Fictional greeting',audio_asset_ids=['audio'],delivery_state='playback_completed',due_at=now,created_at=now,expires_at=now+timedelta(minutes=30))


def test_populated_delivery_migration_preserves_ids_acks_and_uncertainty(legacy):
    populate_legacy_delivery(legacy)
    migrate.upgrade(legacy)
    with legacy.connect() as c:
        rows=c.execute(text('SELECT id,occurrence_id,route_generation,audio_accessed_at FROM reminder_commands')).mappings().all()
        assert len(rows)==1 and rows[0]['id']=='cmd_legacy'
        assert rows[0]['occurrence_id']=='occ_cmd_legacy' and rows[0]['route_generation']==1
        assert rows[0]['audio_accessed_at'] is not None  # Old download state was unobservable.
        assert c.execute(text('SELECT command_id FROM reminder_acks')).scalar_one()=='cmd_legacy'
        assert c.execute(text('SELECT COUNT(*) FROM reminder_occurrences')).scalar_one()==2
        assert c.execute(text('SELECT delivery_state FROM checkin_deliveries')).scalar_one()=='playback_completed'
        assert c.execute(text('SELECT report_state FROM dose_instances')).scalar_one()=='unconfirmed'


def test_downgrade_refuses_to_discard_multiple_delivery_attempts(legacy):
    from sqlalchemy import MetaData
    populate_legacy_delivery(legacy)
    migrate.upgrade(legacy)
    tables=MetaData();tables.reflect(bind=legacy)
    with legacy.begin() as c:
        table=tables.tables['reminder_commands']
        values=dict(c.execute(table.select()).mappings().one())
        values.update(id='cmd_replacement',event_id='evt_replacement',context_id='ctx_replacement',route_generation=2)
        c.execute(table.insert().values(**values))
    with pytest.raises(RuntimeError,match='Routing history exists'):
        with legacy.begin() as c: command.downgrade(migrate.configuration(c),'0002_phone_identity')
    with legacy.connect() as c:
        assert c.execute(text('SELECT COUNT(*) FROM reminder_commands')).scalar_one()==2
        assert c.execute(text('SELECT command_id FROM reminder_acks')).scalar_one()=='cmd_legacy'
