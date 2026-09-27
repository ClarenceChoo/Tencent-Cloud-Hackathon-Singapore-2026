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
