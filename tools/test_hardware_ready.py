import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from check_hardware_ready import CheckFailed, NoRedirectConnect, read_json, check_connection, main


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_redirect_and_oversize_are_rejected(self):
        for response in [httpx.Response(302, headers={'Location':'https://elsewhere.example'}), httpx.Response(200, content=b'x'*16385)]:
            async with httpx.AsyncClient(base_url='https://parse.example', transport=httpx.MockTransport(lambda request:response)) as client:
                with self.assertRaises(CheckFailed):
                    await read_json(client, '/v1/device/info', {'Authorization':'Bearer fictional'})

    async def test_full_loopback_protocol_check_and_no_care_write(self):
        from websockets.asyncio.server import serve
        from websockets.http11 import Response
        from websockets.datastructures import Headers
        paths=[]
        protocol={'version':1,'transport':'wifi','sample_rate_hz':16000,'channels':1,'bits_per_sample':16,'format':'pcm_wav','max_audio_seconds':20,'max_upload_bytes':768*1024}
        def process(connection, request):
            paths.append(request.path)
            if request.path != '/healthz' and request.headers.get('Authorization') != 'Bearer fictional':
                return Response(401,'Unauthorized',Headers(),b'{}')
            payload={
                '/healthz':{'status':'ok'},
                '/v1/device/info':{'device_id':'test-device','pairing_state':'paired','protocol':protocol,'voice_service':'simulated','scheduler_enabled':False},
                '/v1/device/pending-commands':{'commands':[],'current_plan_version':None},
            }.get(request.path)
            if payload is not None:
                return Response(200,'OK',Headers({'Content-Type':'application/json','Connection':'close'}),json.dumps(payload).encode())
        async def handler(socket):
            self.assertEqual(json.loads(await socket.recv()), {'type':'heartbeat'})
            await socket.send(json.dumps({'type':'heartbeat.ack','protocol_version':1,'device_id':'test-device'}))
            await socket.wait_closed()
        async with serve(handler, '127.0.0.1', 0, process_request=process) as server:
            port=server.sockets[0].getsockname()[1]
            report=await check_connection('http://127.0.0.1:%d'%port,'fictional')
            self.assertTrue(report['transport_ready'])
            self.assertFalse(report['ready_for_live_voice_trial'])
            self.assertFalse(report['physical_hardware_verified'])
            self.assertNotIn('fictional',json.dumps(report))
            with self.assertRaises(CheckFailed):
                await check_connection('http://127.0.0.1:%d'%port,'bad-token')
        self.assertTrue(all(path in ['/healthz','/v1/device/info','/v1/device/pending-commands','/v1/device/events'] for path in paths))

    def test_websocket_redirect_is_never_followed(self):
        from websockets.exceptions import InvalidStatus
        from websockets.http11 import Response
        from websockets.datastructures import Headers
        error=InvalidStatus(Response(302,'Found',Headers({'Location':'wss://another.example'})))
        self.assertIs(NoRedirectConnect('wss://parse.example').process_redirect(error),error)


class PrivateInputTests(unittest.TestCase):
    def test_cli_reads_private_nvs_without_printing_token(self):
        with tempfile.TemporaryDirectory() as directory:
            nvs=Path(directory)/'device-nvs.csv'
            nvs.write_text('key,type,encoding,value\ncareloop,namespace,,\ntoken,data,string,fictional-secret\n')
            output=io.StringIO()
            report={'transport_ready':True,'ready_for_live_voice_trial':False}
            with patch('sys.argv',['check','--base-url','https://parse.example','--nvs-file',str(nvs),'--require-voice-config']), patch('check_hardware_ready.check_connection',new_callable=AsyncMock,return_value=report) as check, contextlib.redirect_stdout(output):
                self.assertEqual(main(),2)
                check.assert_awaited_once_with('https://parse.example','fictional-secret')
            self.assertNotIn('fictional-secret',output.getvalue())


if __name__ == '__main__':
    unittest.main()
