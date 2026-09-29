#!/usr/bin/env python3
"""Check a claimed pendant's server connection without recording or changing care data.

Requires the backend virtual environment. A diagnostic heartbeat temporarily updates
connection status; this does not establish that a physical pendant is online.
"""
import argparse
import asyncio
import csv
import json
import os
import sys

import httpx
from websockets.asyncio.client import connect

from device_harness import base_url


class CheckFailed(Exception):
    pass


class NoRedirectConnect(connect):
    def process_redirect(self, exc):
        # Never follow even a same-origin redirect with the device credential.
        return exc


async def read_json(client, path, headers=None):
    async with client.stream('GET', path, headers=headers) as response:
        if response.status_code != 200:
            raise CheckFailed('%s returned HTTP %d; check pairing, address and access.' % (path, response.status_code))
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > 16384:
                raise CheckFailed('%s exceeded the device response limit.' % path)
    result = json.loads(body)
    if not isinstance(result, dict):
        raise CheckFailed('%s did not return a JSON object.' % path)
    return result


async def check_connection(address, token):
    headers = {'Authorization': 'Bearer ' + token}
    async with httpx.AsyncClient(base_url=address, follow_redirects=False, timeout=10, trust_env=False) as client:
        health = await read_json(client, '/healthz')
        if health.get('status') != 'ok':
            raise CheckFailed('The health check did not report ok.')
        info = await read_json(client, '/v1/device/info', headers)
        expected = {'version':1, 'transport':'wifi', 'sample_rate_hz':16000, 'channels':1, 'bits_per_sample':16, 'format':'pcm_wav', 'max_audio_seconds':20, 'max_upload_bytes':768*1024}
        if any(info.get('protocol', {}).get(key) != value for key, value in expected.items()):
            raise CheckFailed('The server audio protocol does not match this firmware.')
        if not info.get('device_id') or info.get('pairing_state') != 'paired':
            raise CheckFailed('The credential is not bound to a paired device.')
        pending = await read_json(client, '/v1/device/pending-commands', headers)
        if not isinstance(pending.get('commands'), list) or 'current_plan_version' not in pending:
            raise CheckFailed('Reminder reconciliation returned an incompatible response.')
    websocket_url = ('wss://' if address.startswith('https://') else 'ws://') + address.split('://',1)[1] + '/v1/device/events'
    async with NoRedirectConnect(websocket_url, additional_headers=headers, proxy=None,
                                 open_timeout=10, close_timeout=3, max_size=16384) as socket:
        await socket.send(json.dumps({'type':'heartbeat'}))
        async with asyncio.timeout(10):
            for _ in range(128):
                event = json.loads(await socket.recv())
                if event.get('type') == 'heartbeat.ack':
                    if event.get('device_id') != info['device_id'] or event.get('protocol_version') != 1:
                        raise CheckFailed('Heartbeat acknowledgement does not match the paired device.')
                    break
            else:
                raise CheckFailed('No heartbeat acknowledgement was received.')
    warnings = []
    if not address.startswith('https://'):
        warnings.append('Loopback test only; public HTTPS/WSS has not been checked.')
    if info.get('service_address') != address:
        warnings.append('Set CARELOOP_PUBLIC_BASE_URL to the exact public HTTPS address.')
    if info.get('voice_service') != 'configured':
        warnings.append('Live voice provider configuration is not ready.')
    if not info.get('scheduler_enabled'):
        warnings.append('Scheduled reminders are disabled.')
    warnings.append('Live provider calls, microphone, speaker and physical hardware still need a bench test.')
    return {'transport_ready':True, 'device_id':info['device_id'],
            'https_checked':address.startswith('https://'), 'authenticated_events_checked':True,
            'voice_service':info.get('voice_service'), 'scheduler_enabled':info.get('scheduler_enabled'),
            'ready_for_live_voice_trial':len(warnings)==1, 'physical_hardware_verified':False,
            'warnings':warnings}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--token-env', default='CARELOOP_DEVICE_TOKEN')
    parser.add_argument('--nvs-file', help='Read the credential from a private device-nvs.csv instead of the environment')
    parser.add_argument('--allow-insecure-loopback', action='store_true')
    parser.add_argument('--require-voice-config', action='store_true')
    args = parser.parse_args()
    try:
        address = base_url(args.base_url, args.allow_insecure_loopback)
        token = os.getenv(args.token_env, '')
        if args.nvs_file:
            with open(args.nvs_file, newline='') as source:
                token = next((row['value'] for row in csv.DictReader(source) if row['key']=='token' and row['type']=='data'), '')
        if not token or any(c.isspace() or ord(c)<33 for c in token):
            raise CheckFailed('Set the device-token environment variable privately before running this check.')
        report = asyncio.run(check_connection(address, token))
    except CheckFailed as exc:
        print(json.dumps({'transport_ready':False, 'error':str(exc)})); return 1
    except Exception as exc:
        # Provider bodies, credentials and WebSocket handshake headers are never logged.
        print(json.dumps({'transport_ready':False, 'error':'Connection check failed (%s). Check TLS, network and server logs.' % type(exc).__name__})); return 1
    print(json.dumps(report, indent=2))
    return 2 if args.require_voice_config and not report['ready_for_live_voice_trial'] else 0


if __name__ == '__main__':
    sys.exit(main())
