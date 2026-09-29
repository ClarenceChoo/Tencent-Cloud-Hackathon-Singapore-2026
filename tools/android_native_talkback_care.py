#!/usr/bin/env python3
"""Native TalkBack note correction/confirmation; fictional interpretation only."""
import json
import os
import select
import sqlite3
import subprocess
import time
from android_native_talkback_probe import main, now


def run_care(c):
    root, out, fixture_dir = c['root'], c['out'], c['fixture_dir']
    report = c['report']
    suffix = str(int(time.time() * 1000))
    wording = {'original': 'Fictional TalkBack right knee concern ' + suffix,
               'corrected': 'Fictional TalkBack left knee concern ' + suffix}
    evidence = report['care'] = {'wording': wording, 'started_at': now()}
    pending = fixture_dir / 'next-utterance.json'
    assert not pending.exists(), 'Do not replace another armed fictional utterance'
    original_uploads = c['uploads']()
    capture_log = fixture_dir / 'native-captures.jsonl'
    captures_before = len(capture_log.read_text().splitlines())
    owns_pending = False
    process = subprocess.Popen(['node', str(root / 'tools/android_talkback_dashboard.cjs'),
                                str(fixture_dir), json.dumps(wording)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def receive():
        assert select.select([process.stdout], [], [], 45)[0], 'Dashboard observer timed out'
        line = process.stdout.readline()
        assert line, 'Dashboard observer stopped'
        result = json.loads(line)
        assert 'error' not in result, result
        return result

    def observe(op):
        process.stdin.write(json.dumps({'op': op}) + '\n'); process.stdin.flush()
        return receive()

    index = 200

    def seek(label, direction='next', limit=40, text=False):
        nonlocal index
        for _ in range(limit):
            index += 1
            value = c['next_focus'](index, direction)
            focused = c['focused'](value)
            if any((label in node if text else 'CONTENT{' + label + '}' in node) for node in focused):
                return value
        raise AssertionError('TalkBack gestures did not reach ' + label)

    def proposal(text):
        with sqlite3.connect(f'file:{fixture_dir / "fixture.db"}?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute('SELECT id, status, payload, readback, context_id, replaces_proposal_id, source_turn_id FROM confirmation_proposals WHERE patient_id=? ORDER BY created_at DESC',
                              (c['fixture']['patient_id'],)).fetchall()
            for row in rows:
                data = dict(row); data['payload'] = json.loads(data['payload'])
                if data['payload'].get('wording') == text: return data
        raise AssertionError('No matching native proposal')

    def speech_assets(proposal_id):
        with sqlite3.connect(f'file:{fixture_dir / "fixture.db"}?mode=ro', uri=True) as db:
            return sorted(row[0] for row in db.execute(
                "SELECT id FROM audio_assets WHERE json_extract(context_guard, '$.proposal_id')=? AND json_extract(context_guard, '$.status')='pending'",
                (proposal_id,)))

    def record(key, interpretation):
        nonlocal owns_pending
        seek('Tap to start recording', 'previous')
        assert not pending.exists() and not c['files']()
        temporary = pending.with_suffix('.tmp')
        temporary.write_text(json.dumps({'name': 'talkback-' + key + '-' + suffix,
                                         'transcript': 'FIXTURE:' + json.dumps(interpretation)}))
        os.chmod(temporary, 0o600); temporary.replace(pending); owns_pending = True
        c['double_tap']()
        deadline = time.monotonic() + 6
        while True:
            value = c['dump']('talkback-care-recording-' + key)
            if any('CONTENT{Recording. Tap to send.}' in node for node in c['focused'](value)): break
            assert time.monotonic() < deadline, 'Recording must start with focused send control'
            time.sleep(.2)
        assert c['files']()
        time.sleep(.8)
        c['double_tap']()
        deadline = time.monotonic() + 25
        while True:
            value = c['dump']('talkback-care-response-' + key)
            buttons = [node for node in value.splitlines() if 'CONTENT{Tap to start recording}' in node]
            if not pending.exists() and buttons and all(':disabled' not in n for n in buttons): break
            assert time.monotonic() < deadline, 'Native TalkBack voice turn did not settle'
            time.sleep(.3)
        owns_pending = False
        assert 'CONTENT{Recover response}' not in value and not c['files']()
        evidence[key + '_proposal'] = proposal(wording[key])
        assert evidence[key + '_proposal']['status'] == 'pending'
        assert 'Fictional Jamie Lim' in evidence[key + '_proposal']['readback']
        evidence[key + '_unsaved'] = observe('unsaved')
        c['save']()

    try:
        evidence['observer'] = receive()
        assert evidence['observer']['ready']
        payload = lambda key: {'wording': wording[key], 'occurrence_text': 'after a fictional walk',
                              'share_with_user_ids': [c['fixture']['caregiver_id']]}
        record('original', {'intent': 'proposal', 'kind': 'health_note', 'payload': payload('original')})
        seek('Have I got that right?', text=True)
        value = seek(wording['original'], text=True)
        assert any('Fictional Jamie Lim' in n for n in c['focused'](value))
        c['screenshot']('talkback-care-original-review')
        c['passed']('TalkBack recording returns an unsaved note; gesture navigation reaches the review and its named recipient')

        record('corrected', {'intent': 'correct', 'payload': payload('corrected')})
        old = proposal(wording['original']); corrected = evidence['corrected_proposal']
        assert old['status'] == 'invalidated'
        assert corrected['replaces_proposal_id'] == old['id']
        assert corrected['context_id'] != old['context_id']
        evidence['original_after_correction'] = old
        seek('Have I got that right?', text=True)
        value = seek(wording['corrected'], text=True)
        assert any('Fictional Jamie Lim' in n for n in c['focused'](value))
        c['screenshot']('talkback-care-corrected-review')
        seek('Hear this read-back')
        assets_before = speech_assets(corrected['id'])
        c['double_tap']()
        deadline = time.monotonic() + 12
        while True:
            value = c['dump']('talkback-care-readback-playback')
            controls = [n for n in value.splitlines() if 'CONTENT{Confirm and save}' in n]
            new_assets = sorted(set(speech_assets(corrected['id'])) - set(assets_before))
            if new_assets and controls and all(':disabled' not in n for n in controls): break
            assert time.monotonic() < deadline
            time.sleep(.3)
        evidence['readback_requested_asset_ids'] = new_assets
        seek('Confirm and save')
        c['screenshot']('talkback-care-confirm-focused')
        evidence['before_confirmation'] = observe('unsaved')
        c['passed']('TalkBack correction replaces the old context; the corrected read-back, recipient and explicit Confirm control are reachable before saving')
        evidence['confirmation_gesture_at'] = now()
        c['double_tap']()
        evidence['saved'] = observe('saved')
        assert evidence['saved']['note']['provenance']['proposal_id'] == corrected['id']
        evidence['uploads_after'] = c['uploads']()
        assert evidence['uploads_after'] == original_uploads + 2
        assert not c['files']()
        evidence['captures'] = [json.loads(line) for line in capture_log.read_text().splitlines()[captures_before:]]
        assert len(evidence['captures']) == 2
        c['screenshot']('talkback-care-confirmed')
        c['passed']('TalkBack double-tap confirms one corrected phone-sourced note; the already-open permitted caregiver updates and the restricted caregiver does not')

        # Background/reopen with the service still active; keep the same pairing.
        c['adb']('shell', 'input', 'keyevent', 'KEYCODE_HOME')
        c['adb']('shell', 'am', 'start', '-W', '-n', c['app'] + '/sg.parse.companion.MainActivity')
        time.sleep(1)
        resumed = c['dump']('talkback-care-resumed')
        assert 'HELLO, Mei' in resumed and wording['corrected'] in resumed
        assert 'CONTENT{Confirm and save}' not in resumed
        c['screenshot']('talkback-care-resumed')
        evidence['after_resume'] = observe('saved')
        assert evidence['after_resume']['note']['id'] == evidence['saved']['note']['id']
        assert c['uploads']() == evidence['uploads_after'] and not c['files']()
        c['passed']('Resuming the TalkBack-enabled companion preserves the one confirmed record without replaying a voice upload')
    finally:
        c['adb']('shell', 'input', 'keyevent', 'KEYCODE_HOME')
        if owns_pending and pending.exists(): pending.unlink()
        if process.poll() is None:
            try: observe('close'); process.wait(timeout=10)
            except Exception:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
        evidence['observer_exit_code'] = process.returncode
        c['save']()
        assert process.returncode == 0, 'Dashboard observer must exit without forced termination'


if __name__ == '__main__':
    main(care=run_care)
