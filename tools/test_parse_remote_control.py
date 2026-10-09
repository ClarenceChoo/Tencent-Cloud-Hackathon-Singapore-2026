import tempfile
import unittest
from uuid import uuid4
from parse_remote_control import RemoteControl

class FakeRelay:
    def __init__(self):
        self.session={'room_id':str(uuid4())}
        self.command={'id':str(uuid4()),'kind':'capture','state':'queued'}
        self.claim=None
        self.fail_claim_response=False
    def control(self, data):
        action=data.get('action')
        if action=='claim':
            if self.claim and self.claim!=data['claimId']:
                raise RuntimeError('Already claimed')
            self.claim=data['claimId'];self.command['state']='claimed'
            if self.fail_claim_response:
                self.fail_claim_response=False
                raise RuntimeError('Lost reply after server commit')
            return {'command':dict(self.command),'claimed':True}
        if action in {'complete','failed'}:
            assert self.claim==data['claimId']
            self.command['state']=action
            return {'accepted':True}
        return {'command':dict(self.command) if self.command['state'] in {'queued','claimed'} else None}

class RemoteTests(unittest.TestCase):
    def test_claim_loss_retry_does_not_repeat_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay=FakeRelay();starts=[]
            def start(kind,done):starts.append((kind,done));return True
            control=RemoteControl(relay,tmp,lambda:{'busy':False},start)
            relay.fail_claim_response=True
            with self.assertRaises(RuntimeError):control.tick()
            self.assertEqual(starts,[])
            control.tick();control.tick()
            self.assertEqual(len(starts),1)
            starts[0][1](True);control.tick();control.tick()
            self.assertEqual(relay.command['state'],'complete');self.assertEqual(len(starts),1)
    def test_restart_never_repeats_started_microphone_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay=FakeRelay();starts=[]
            start=lambda kind,done:starts.append(kind) or True
            RemoteControl(relay,tmp,lambda:{'busy':False},start).tick()
            RemoteControl(relay,tmp,lambda:{'busy':False},start).tick()
            self.assertEqual(starts,['capture']);self.assertEqual(relay.command['state'],'failed')
    def test_idle_poll_and_busy_laptop_do_not_start_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay=FakeRelay();starts=[]
            control=RemoteControl(relay,tmp,lambda:{'busy':True},lambda *args:starts.append(args))
            control.tick();self.assertEqual(starts,[]);self.assertIsNone(relay.claim)
            relay.command['state']='complete';control.tick();self.assertEqual(starts,[])

if __name__=='__main__':unittest.main()
