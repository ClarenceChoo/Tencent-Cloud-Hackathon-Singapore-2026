"""Native multi-clip and stalled-freshness expiry checks on the disposable emulator.

Requires the existing fictional HTTPS fixture and fault proxy. Distinct PCM tones
exercise Android media decoding/callbacks, not speech intelligibility. No installed
credential is read and no care record is created, confirmed or reset.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import threading
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'runtime/native-care-20260927'
ADB = ROOT / 'runtime/android-build/sdk/platform-tools/adb'
APP = 'sg.parse.companion.verification'
SERIAL = 'emulator-5580'
OUT = None


def adb(*args, required=True):
    result = subprocess.run([str(ADB), '-s', SERIAL, *args], capture_output=True, timeout=25)
    if required:
        result.check_returncode()
    return result.stdout


def ui():
    adb('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/parse-sequence-ui.xml')
    raw = adb('exec-out', 'cat', '/sdcard/parse-sequence-ui.xml')
    (OUT / 'last-ui.xml').write_bytes(raw)
    return [n.attrib for n in ET.fromstring(raw).iter('node')]


def find(label, scroll=True):
    for attempt in range(8):
        for n in ui():
            if label in [n.get('text'), n.get('content-desc')] and n.get('enabled') == 'true':
                box = list(map(int, re.findall(r'\d+', n['bounds'])))
                if box[3] > box[1]:
                    return box
        if scroll:
            adb('shell', 'input', 'swipe', '950', '650' if attempt < 2 else '1850',
                '950', '1850' if attempt < 2 else '650', '300')
    raise AssertionError('Native control unavailable: ' + label)


def tap(label):
    a, b, c, d = find(label)
    adb('shell', 'input', 'tap', str((a+c)//2), str((b+d)//2))


def shot(name):
    ui()
    (OUT / (name + '.xml')).write_bytes((OUT / 'last-ui.xml').read_bytes())
    (OUT / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))


def rows(sql, args=()):
    with sqlite3.connect('file:' + str(FIXTURE / 'fixture.db') + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(sql, args)]


def care():
    result = {}
    for table in ['health_notes', 'measurements', 'preventive_tasks', 'support_requests', 'followups',
                  'voice_turns', 'confirmation_proposals', 'companion_routes']:
        data = rows('select * from ' + table + (' order by id' if table != 'companion_routes' else ' order by patient_id'))
        result[table] = {'count': len(data), 'sha256': hashlib.sha256(json.dumps(data, sort_keys=True,
            default=lambda value: hashlib.sha256(value).hexdigest()).encode()).hexdigest()}
    result['uploads'] = len((FIXTURE / 'native-uploads.jsonl').read_text().splitlines())
    return result


def events():
    path = FIXTURE / 'fault-events.jsonl'
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def write_config(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data))
    temporary.chmod(0o600)
    temporary.replace(path)


class Monitor:
    def __init__(self, pid):
        self.pid, self.samples, self.failure = pid, [], None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run)

    def run(self):
        try:
            while not self.done.is_set():
                files = adb('shell', 'find', '/data/user/0/' + APP + '/cache', '-maxdepth', '1',
                            '-name', 'parse-reply-*.wav').decode().splitlines()
                cached = []
                for file in files:
                    assert re.fullmatch('/data/user/0/' + re.escape(APP) + r'/cache/parse-reply-[a-f0-9-]+\.wav', file)
                    digest = adb('shell', 'sha256sum', file, required=False).decode().split()
                    if digest and re.fullmatch('[a-f0-9]{64}', digest[0]):
                        cached.append({'name': file.rsplit('/', 1)[1], 'sha256': digest[0]})
                audio = adb('shell', 'dumpsys', 'audio').decode()
                active = [line.strip() for line in audio.splitlines()
                          if 'AudioPlaybackConfiguration piid:' in line and '/' + self.pid + ' ' in line and 'state:started' in line]
                self.samples.append({'at_ms': time.time()*1000, 'cache': cached, 'active': active})
                self.done.wait(.15)
        except Exception as error:
            self.failure = str(error)

    def start(self):
        self.thread.start()

    def stop(self):
        self.done.set()
        self.thread.join(timeout=30)
        assert not self.thread.is_alive()
        assert self.failure is None, self.failure


def main():
    global OUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--label', required=True, choices=['r9-before', 'r10-fixed'])
    parser.add_argument('--run-suffix', default='', help='Optional unique suffix; existing evidence is never overwritten.')
    args = parser.parse_args()
    assert re.fullmatch(r'[a-z0-9-]*', args.run_suffix), 'Use only lowercase letters, digits and hyphens for the suffix'
    OUT = ROOT / ('runtime/native-sequence-' + args.label + ('-' + args.run_suffix if args.run_suffix else ''))
    OUT.mkdir(mode=0o700, exist_ok=False)
    report = {'at': datetime.now(timezone.utc).isoformat(), 'label': args.label, 'checks': [],
              'physical_phone': False, 'live_speech': False,
              'environment': 'Rooted Android 16 ARM64 emulator; actual native media player and cache; local verified TLS proxy, scripted distinct PCM tones; host audio disabled.',
              'source_sha256': {p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in [
                  'mobile/src/useVoice.ts', 'mobile/src/App.tsx', 'mobile/src/api.ts', 'tools/android_native_sequence.py',
                  'tools/android_native_fixture.py', 'tools/android_native_fault_proxy.py']}}
    def save():
        (OUT / 'evidence.json').write_text(json.dumps(report, indent=2)+'\n')
    def passed(name):
        report['checks'].append({'name': name, 'passed': True}); save(); print('PASS '+name, flush=True)
    assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() == b'1'
    assert b'uid=0' in adb('shell', 'id')
    assert json.loads((FIXTURE/'fixture.json').read_text())['origin'] == 'https://127.0.0.1:8443'
    assert rows("select id from users where email='owner@native.invalid' and role='owner'")
    config = FIXTURE/'sequence-tone.json'; mode = FIXTURE/'fault-mode.json'
    assert not config.exists() and not (FIXTURE/'next-utterance.json').exists()
    original_mode = mode.read_bytes() if mode.exists() else None
    assert original_mode is None or json.loads(original_mode) == {}
    report['before'] = care()
    installed = adb('shell', 'pm', 'path', APP).decode().strip().removeprefix('package:')
    assert installed.startswith('/data/app/') and '\n' not in installed
    report['installed_apk_sha256'] = adb('shell', 'sha256sum', installed).decode().split()[0]
    expected = (json.loads((ROOT/'docs/careloop/evidence/android-preview-r9-2026-09-28.json').read_text())['verification_apk_sha256']
                if args.label == 'r9-before' else hashlib.sha256((ROOT/'mobile/android/app/build/outputs/apk/nativeVerification/app-nativeVerification.apk').read_bytes()).hexdigest())
    assert report['installed_apk_sha256'] == expected, 'Installed APK does not match this checkpoint'
    start = time.time()*1000; device_ms = int(adb('shell', 'date', '+%s%3N')); end = time.time()*1000
    report['clock_offset_ms'] = device_ms-(start+end)/2
    report['clock_roundtrip_ms'] = end-start
    assert abs(report['clock_offset_ms']) < 1000, 'Restore the emulator clock before expiry measurements'
    monitor = None
    try:
        adb('reverse', 'tcp:8443', 'tcp:8444')
        adb('shell', 'am', 'force-stop', APP)
        adb('shell', 'am', 'start', '-W', '-n', APP+'/sg.parse.companion.MainActivity')
        find('HELLO, Mei'); tap('Settings'); find('Test speaker')
        pid = adb('shell', 'pidof', APP).decode().strip(); assert pid.isdigit()
        report['pid'] = pid
        for name, duration in [('ordered', 6000), ('expired', 18000)]:
            write_config(config, {'max_chars': 35, 'duration_ms': duration})
            write_config(mode, {'observe_audio': True, **({'speaker_deadline_seconds': 3, 'stall_audio_head_seconds': 15} if name == 'expired' else {})})
            offset = len(events()); monitor = Monitor(pid); monitor.start()
            tap('Test speaker')
            deadline = time.monotonic()+45
            response = None
            while time.monotonic() < deadline:
                response = next((e for e in events()[offset:] if e['kind'] == 'speaker_sequence'), None)
                samples = monitor.samples
                all_downloaded = response and len([e for e in events()[offset:] if e['kind']=='audio_request' and e['method']=='GET' and e['upstream_status']==200]) == len(response['audio_paths'])
                past_deadline = response and time.time()*1000 > datetime.fromisoformat(response['expires_at'].replace('Z', '+00:00')).timestamp()*1000-report['clock_offset_ms']+1500
                if response and (past_deadline if name == 'expired' else all_downloaded) and any(s['active'] for s in samples) and len(samples) >= 3 and all(not s['active'] and not s['cache'] for s in samples[-3:]):
                    break
                time.sleep(.2)
            monitor.stop(); samples = monitor.samples; monitor = None
            assert response, 'Native speaker request was not observed'
            observed_events = events()[offset:]
            paths = response['audio_paths']
            assets = [rows('select id,device_id,duration_ms,content_sha256 from audio_assets where id=?', (p.rsplit('/',1)[1],))[0] for p in paths]
            route = rows('select active_device_id from companion_routes')[0]['active_device_id']
            assert 2 <= len(paths) <= 20 and len(paths) == len(set(paths))
            assert all(a['device_id'] == route and a['duration_ms'] == duration for a in assets)
            assert len({a['content_sha256'] for a in assets}) == len(assets)
            evidence = {'response': response, 'assets': assets, 'events': observed_events, 'samples': samples}
            report[name] = evidence; save()
            assert not samples[-1]['active'] and not samples[-1]['cache'], 'Playback did not settle and clear its cache'
            assert max(len(s['active']) for s in samples) == 1, 'More than one native track was observed playing'
            downloaded = [e['path'] for e in observed_events if e['kind']=='audio_request' and e['method']=='GET' and e['upstream_status']==200]
            if name == 'ordered':
                assert downloaded == paths, 'Protected downloads must follow envelope order exactly'
                seen = []
                for sample in samples:
                    if sample['active'] and len(sample['cache']) == 1:
                        sha = sample['cache'][0]['sha256']
                        if not seen or seen[-1] != sha: seen.append(sha)
                assert seen == [a['content_sha256'] for a in assets], 'Distinct native clip bytes must follow the reply order'
                passed('Native Android plays distinct protected clips in envelope order, one active track at sampled instants, and clears each cached reply')
                shot('ordered-complete')
            else:
                assert any(e['kind']=='audio_validation_stalled' for e in observed_events), 'No in-flight freshness stall was exercised'
                expiry = datetime.fromisoformat(response['expires_at']).timestamp()*1000-report['clock_offset_ms']
                last_started = max(s['at_ms'] for s in samples if s['active'])
                evidence['last_observed_active_after_deadline_ms'] = last_started-expiry
                evidence['first_clear_after_deadline_ms'] = next((s['at_ms']-expiry for s in samples if s['at_ms']>=expiry and not s['active'] and not s['cache']), None)
                save(); shot('expired-state')
                assert downloaded == paths[:1], 'Expiry must prevent later clips from downloading'
                assert last_started <= expiry+1000, 'Native playback continued beyond the known reply deadline while its freshness request stalled'
                find('This spoken reply has expired. Check the current care details.')
                passed('Local reply expiry stops actual native playback and removes its cached audio despite a stalled network validation; later clips never start')
                before_repeat = len(events()); tap('Repeat spoken reply')
                find('This spoken reply has expired. Check the current care details.')
                assert not [e for e in events()[before_repeat:] if e['kind']=='audio_request']
                assert not any(n.get('content-desc') in ['Recover response','Discard unfinished recording'] for n in ui())
                passed('Repeating an expired reply performs no audio request or playback and exposes no false recording-recovery controls')
        report['after'] = care(); assert report['before'] == report['after']
        passed('Sequence and expiry checks preserve every care/proposal/turn/route record and upload count without microphone use')
    except Exception as error:
        report['failure'] = type(error).__name__ + ': ' + str(error)
        try: shot('failure')
        except Exception: pass
        raise
    finally:
        if monitor: monitor.stop()
        adb('shell', 'am', 'force-stop', APP)
        if config.exists(): config.unlink()
        if original_mode is None:
            if mode.exists(): mode.unlink()
        else: mode.write_bytes(original_mode)
        adb('reverse', 'tcp:8443', 'tcp:8443')
        adb('shell', 'am', 'start', '-W', '-n', APP+'/sg.parse.companion.MainActivity')
        report['cleanup'] = {'sequence_override_removed': not config.exists(), 'direct_fixture_connection_restored': True,
                             'care_unchanged': care() == report['before']}
        save()


if __name__ == '__main__':
    main()
