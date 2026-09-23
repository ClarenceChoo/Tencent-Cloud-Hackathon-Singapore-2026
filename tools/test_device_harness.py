"""Loopback HTTP transport checks. These do not model speech or physical hardware."""
import contextlib
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request
import wave

import device_harness as harness


def wav(seconds=0.4):
    out = io.BytesIO()
    with wave.open(out, 'wb') as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(16000)
        clip.writeframes(b'\0\0' * int(seconds * 16000))
    return out.getvalue()


class HarnessTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.input = self.root / 'input.wav'
        self.input.write_bytes(wav())
        self.uploads = []
        self.assets = []
        self.drop_first = False
        self.asset_status = 200
        self.status = 'awaiting_confirmation'
        self.expiry = '2099-01-01T00:00:00Z'
        self.redirect_target_called = False
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, data, status=200, content_type='application/json'):
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                test.assertEqual(self.path, '/v1/device/turns')
                test.assertEqual(self.headers.get('Authorization'), 'Bearer fictional-token')
                body = self.rfile.read(int(self.headers['Content-Length']))
                test.uploads.append((self.headers.get('Idempotency-Key'), body, self.headers.get('X-Context-Id')))
                if test.drop_first and len(test.uploads) == 1:
                    # The server accepted the turn, but its acknowledgement never arrived.
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.send(json.dumps({'turn_id': 'turn_test', 'status': 'accepted'}).encode(), 202)

            def do_GET(self):
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/redirect-target')
                    self.end_headers()
                elif self.path == '/redirect-target':
                    test.redirect_target_called = True
                    self.send(b'{}')
                elif self.path == '/oversized':
                    self.send(b' ' * (harness.MAX_JSON_BYTES + 1))
                elif self.path.startswith('/v1/device/audio/'):
                    test.assets.append(self.path)
                    self.send(wav(), test.asset_status, 'audio/wav')
                else:
                    test.assertEqual(self.path, '/v1/device/turns/turn_test')
                    payload = {'turn_id': 'turn_test', 'status': test.status, 'context_id': 'ctx_test', 'spoken_text': 'Fictional transport fixture.', 'record_type': 'health_note' if test.status == 'committed' else None, 'record_id': 'note_test' if test.status == 'committed' else None, 'audio_paths': ['/v1/device/audio/clip_one', '/v1/device/audio/clip_two']}
                    self.send(json.dumps({'turn_id': 'turn_test', 'status': test.status, 'event': {'expires_at': test.expiry, 'payload': payload}}).encode())

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.opener = urllib.request.build_opener(harness.NoRedirect())

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def run_cli(self, *extra):
        args = ['device_harness.py', '--base-url', self.url, '--allow-insecure-loopback', '--wav', str(self.input), '--state', str(self.root / 'state.json'), '--output-dir', str(self.root / 'replies'), *extra]
        output = io.StringIO()
        with patch('sys.argv', args), patch.dict('os.environ', {'CARELOOP_DEVICE_TOKEN': 'fictional-token'}), patch.object(harness.time, 'sleep'), contextlib.redirect_stdout(output):
            harness.main()
        return json.loads(output.getvalue())

    def test_lost_upload_ack_reuses_identity_and_later_runs_only_poll(self):
        self.drop_first = True
        first = self.run_cli('--context-id', 'ctx_original')
        self.assertEqual(len(self.uploads), 2)
        self.assertEqual(self.uploads[0], self.uploads[1])
        self.assertEqual(first['status'], 'awaiting_confirmation')
        self.assertEqual(first['context_id'], 'ctx_test')
        self.assertEqual([Path(p).name for p in first['reply_files']], ['clip_one.wav', 'clip_two.wav'])
        second = self.run_cli('--context-id', 'ctx_original')
        self.assertEqual(first['turn_id'], second['turn_id'])
        self.assertEqual(len(self.uploads), 2, 'Resumption must not create a second upload')

    def test_expired_audio_preserves_committed_outcome(self):
        self.status = 'committed'
        self.expiry = '2000-01-01T00:00:00Z'
        result = self.run_cli()
        self.assertEqual((result['status'], result['record_id']), ('committed', 'note_test'))
        self.assertEqual(result['reply_status'], 'expired')
        self.assertIsNone(result['context_id'])
        self.assertEqual(self.assets, [])

    def test_unavailable_audio_does_not_erase_saved_record(self):
        self.status = 'committed'
        self.asset_status = 410
        result = self.run_cli()
        self.assertEqual(result['record_id'], 'note_test')
        self.assertEqual(result['reply_status'], 'unavailable')
        self.assertEqual(result['reply_files'], [])

    def test_retry_rejects_changed_recording_or_context(self):
        self.run_cli()
        with self.assertRaisesRegex(ValueError, 'different recording'):
            self.run_cli('--context-id', 'different')
        self.input.write_bytes(wav(0.5))
        with self.assertRaisesRegex(ValueError, 'different recording'):
            self.run_cli()
        self.assertEqual(len(self.uploads), 1)

    def test_json_response_limit(self):
        with self.assertRaisesRegex(ValueError, 'exceeds'):
            harness.request(self.opener, self.url + '/oversized', 'fictional-token')

    def test_redirect_is_never_followed(self):
        with self.assertRaisesRegex(RuntimeError, '302'):
            harness.request(self.opener, self.url + '/redirect', 'fictional-token')
        self.assertFalse(self.redirect_target_called)

    def test_sequence_bounds_and_paths_are_checked_before_fetch(self):
        for paths in ([f'/v1/device/audio/{i}' for i in range(21)], ['https://other.invalid/audio'], ['/v1/device/audio/../private'], 'not-an-array'):
            with self.subTest(paths=paths), patch.object(harness, 'request') as request:
                with self.assertRaises(ValueError):
                    harness.reply_files(self.opener, self.url, 'fictional-token', {'expires_at': self.expiry, 'payload': {'audio_paths': paths}}, self.root / 'replies')
                request.assert_not_called()

    def test_total_audio_duration_has_no_partial_output(self):
        event = {'expires_at': self.expiry, 'payload': {'audio_paths': [f'/v1/device/audio/{i}' for i in range(7)]}}
        with patch.object(harness, 'request', return_value=wav(20)):
            with self.assertRaisesRegex(ValueError, '120 seconds'):
                harness.reply_files(self.opener, self.url, 'fictional-token', event, self.root / 'replies')
        self.assertFalse((self.root / 'replies').exists())


if __name__ == '__main__':
    unittest.main()
