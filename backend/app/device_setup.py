"""Pairing diagnostics contain configuration/transport facts, never credentials."""
from datetime import timedelta
from .providers import get_provider, TencentProvider, FixtureProvider, unsupported_vocabulary_capability
from .security import aware, iso, utcnow

PROTOCOL = {
    'version': 1, 'transport': 'wifi', 'sample_rate_hz': 16000,
    'channels': 1, 'bits_per_sample': 16, 'format': 'pcm_wav',
    'min_audio_seconds': 0.3, 'max_audio_seconds': 20,
    'max_upload_bytes': 768 * 1024, 'heartbeat_seconds': 5,
    'offline_after_seconds': 15,
}


def service_readiness(app) -> dict:
    voice = 'unconfigured'
    vocabulary_capability = unsupported_vocabulary_capability()
    try:
        provider = get_provider(fixture_transcripts=app.state.fixture_transcripts)
        vocabulary_capability = provider.capabilities()
        if isinstance(provider, TencentProvider):
            voice = 'configured'
        elif isinstance(provider, FixtureProvider):
            voice = 'simulated'
    except Exception:
        voice = 'invalid_configuration'
    return {
        'service_address': app.state.settings.public_base_url or None,
        'voice_service': voice,
        'live_voice_verified': False,
        'scheduler_enabled': app.state.settings.scheduler_enabled,
        'speech_vocabulary': vocabulary_capability,
        'protocol': PROTOCOL,
    }


def device_status(device, connected_ids: set[str], phone_state=None, selected=False) -> dict:
    fresh = bool(device.last_seen and timedelta(0) <= utcnow() - aware(device.last_seen) <= timedelta(seconds=15))
    foreground=bool(phone_state and phone_state.lifecycle=='foreground' and fresh)
    background_alerts=bool(phone_state and phone_state.notification_permission in {'granted','provisional'} and phone_state.scheduled_until and aware(phone_state.scheduled_until)>utcnow() and selected and not device.revoked_at)
    state = ('revoked' if device.revoked_at else 'connected' if fresh and (device.id in connected_ids or device.device_type=='phone' and foreground)
             else 'stale' if device.last_seen else 'awaiting_connection')
    return {
        'id': device.id, 'status': state,
        'selected':selected,
        'phone_presence': ({'foreground_ready':foreground and phone_state.microphone_permission=='granted' and not device.revoked_at,
                            'last_reported_lifecycle':phone_state.lifecycle,'microphone_permission':phone_state.microphone_permission,
                            'notification_permission':phone_state.notification_permission,'background_alerts_enabled':background_alerts,
                            'scheduled_until':iso(phone_state.scheduled_until),'reported_at':iso(phone_state.reported_at),
                            'push_registered':bool(phone_state.push_token and not phone_state.push_disabled_at and not device.revoked_at)} if phone_state else None), 'claimed_at': iso(device.claimed_at),
        'device_type': device.device_type, 'platform': device.platform,
        'display_name': device.display_name,
        'last_seen': iso(device.last_seen), 'battery_mv': device.battery_mv,
        'rssi': device.rssi, 'firmware_version': device.firmware_version,
        'revoked_at': iso(device.revoked_at),
    }
