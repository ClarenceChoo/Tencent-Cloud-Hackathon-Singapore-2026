"""Pairing diagnostics contain configuration/transport facts, never credentials."""
from datetime import timedelta
from .providers import get_provider, TencentProvider, FixtureProvider
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
    try:
        provider = get_provider(fixture_transcripts=app.state.fixture_transcripts)
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
        'protocol': PROTOCOL,
    }


def device_status(device, connected_ids: set[str]) -> dict:
    fresh = bool(device.last_seen and timedelta(0) <= utcnow() - aware(device.last_seen) <= timedelta(seconds=15))
    state = ('revoked' if device.revoked_at else 'connected' if fresh and device.id in connected_ids
             else 'stale' if device.last_seen else 'awaiting_connection')
    return {
        'id': device.id, 'status': state, 'claimed_at': iso(device.claimed_at),
        'last_seen': iso(device.last_seen), 'battery_mv': device.battery_mv,
        'rssi': device.rssi, 'firmware_version': device.firmware_version,
        'revoked_at': iso(device.revoked_at),
    }
