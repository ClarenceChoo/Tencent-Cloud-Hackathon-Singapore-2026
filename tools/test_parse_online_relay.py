import io
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4
import wave

import httpx
from parse_online_relay import COOKIE, PHONE, OnlineParseRelay, RelayError


class OnlineRelayTests(unittest.TestCase):
    def test_pairing_and_retry_reuse_exact_audio_and_recording(self):
        room = str(uuid4())
        received, ids = [], []
        def server(request):
            self.assertEqual(str(request.url).split('/api/')[0], PHONE)
            self.assertEqual(request.headers['origin'], PHONE)
            path = request.url.path
            if path.endswith('/claim'):
                return httpx.Response(201, json={'room': {'id': room, 'clientType': 'esp32', 'state': 'pending'}}, headers={'Set-Cookie': COOKIE+'='+'b'*64+'; Path=/api/voice; Secure; HttpOnly'})
            self.assertEqual(request.headers['cookie'], COOKIE+'='+'b'*64)
            if request.method == 'GET':
                return httpx.Response(200, json={'room': {'id': room, 'clientType': 'esp32', 'state': 'paired'}})
            if path.endswith('/recordings'):
                data = json.loads(request.content)
                ids.append(data['recordingId'])
                return httpx.Response(201, json={'recording': {'id': ids[-1], 'state': 'receiving' if len(ids)==1 else 'ready', 'chunks': len(received)}})
            if '/chunks/' in path:
                with wave.open(io.BytesIO(request.content), 'rb') as wav:
                    self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 16000))
                    received.append(wav.readframes(wav.getnframes()))
                return httpx.Response(200, json={'accepted': True})
            return httpx.Response(200, json={'relay': {'transcript': 'Fictional walk test', 'spokenText': 'Please review this note.', 'functionName': 'propose_health_note', 'proposalId': 'proposal-1', 'proposalStatus': 'pending'}})
        with tempfile.TemporaryDirectory() as tmp:
            relay = OnlineParseRelay(tmp, transport=httpx.MockTransport(server))
            relay.pair(PHONE+'/phone?room='+room+'#pair='+'a'*64)
            self.assertEqual(relay.path.stat().st_mode & 0o777, 0o600)
            raw = b'\x23\x00' * 24000
            source = Path(tmp)/'mic.wav'
            with wave.open(str(source), 'wb') as wav:
                wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                wav.writeframes(raw)
            a=relay.submit(source, lambda **kw: None)
            restored=OnlineParseRelay(tmp, transport=httpx.MockTransport(server))
            b=restored.submit(source, lambda **kw: None)
            self.assertEqual(a, b)
            self.assertEqual(ids[0], ids[1])
            self.assertEqual(b''.join(received), raw)
            self.assertEqual(len(received), 2)

    def test_foreign_invitation_and_redirect_never_receive_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls=[]
            def server(request):
                calls.append(str(request.url))
                return httpx.Response(302, headers={'Location':'https://outside.invalid/'})
            relay=OnlineParseRelay(tmp,transport=httpx.MockTransport(server))
            with self.assertRaises(RelayError):
                relay.pair('https://outside.invalid/phone?room='+str(uuid4())+'#pair='+'a'*64)
            self.assertEqual(calls,[])
            with self.assertRaises(RelayError):
                relay.pair(PHONE+'/phone?room='+str(uuid4())+'#pair='+'a'*64)
            self.assertEqual(len(calls),1)
            self.assertFalse(relay.path.exists())


if __name__ == '__main__':
    unittest.main()
