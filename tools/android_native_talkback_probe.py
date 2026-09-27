#!/usr/bin/env python3
"""Real TalkBack gestures on the already-configured, fictional Android emulator."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'runtime/android-accessibility'
FIXTURE = ROOT / 'runtime/native-care-20260927'
APP = 'sg.parse.companion.verification'
ADB = [str(ROOT / 'runtime/android-build/sdk/platform-tools/adb'), '-s', 'emulator-5580']

def adb(*args, binary=False):
    return subprocess.check_output(ADB + list(args), text=not binary, timeout=15)

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    fixture = json.loads((FIXTURE / 'fixture.json').read_text())
    assert fixture['origin'].startswith('https://127.0.0.1:')
    assert 'uid=0' in adb('shell', 'id')
    assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() == '1'
    original = json.loads((OUT / 'original-settings.json').read_text())
    assert original['enabled_accessibility_services'] == 'null' and original['accessibility_enabled'] == '0'
    mode = json.loads((OUT / 'original-parse-tap-mode.json').read_text())
    assert mode == {'tap_mode_before': True, 'tap_mode_before_talkback': False}
    report = {'at': now(), 'physical_phone': False, 'live_speech': False,
              'scope': 'Real TalkBack focus and double-tap gestures, native recording and cancellation on the Android 16 emulator. Host audio disabled; no audibility, live speech or full accessibility acceptance.',
              'source_sha256': {str(p.relative_to(ROOT)): digest(p) for p in [Path(__file__).resolve(), ROOT / 'mobile/src/App.tsx', ROOT / 'mobile/src/useTalkMode.ts', ROOT / 'mobile/src/useVoice.ts', ROOT / 'tools/android_emulator_touch.c']},
              'parse_apk_sha256': digest(ROOT / 'mobile/android/app/build/outputs/apk/nativeVerification/app-nativeVerification.apk'),
              'tooling_provenance_sha256': digest(OUT / 'setup-provenance.json'),
              'checks': [], 'focus_sequence': []}
    def save():
        (OUT / 'talkback-probe.json').write_text(json.dumps(report, indent=2) + '\n')
    def passed(name):
        report['checks'].append({'name': name, 'passed': True}); save(); print('PASS', name, flush=True)
    def dump(name):
        value = adb('shell', 'dumpsys', 'activity', 'service', 'TalkBackService', 'basic_info', 'node_hierarchy', 'speech_controller')
        (OUT / (name + '.txt')).write_text(value)
        assert 'LogUtils.getLogLevel=VERBOSE' in value and 'Current Node Hierarchy:' in value
        return value
    def focused(value):
        return list(dict.fromkeys(line.strip() for line in value.splitlines() if ':accessibilityFocused' in line))
    def screenshot(name):
        (OUT / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
    def files():
        return adb('shell', 'find', '/data/user/0/' + APP + '/cache', '-type', 'f', '-name', 'recording-*').splitlines()
    def uploads():
        return len((FIXTURE / 'native-uploads.jsonl').read_text().strip().splitlines())
    def next_focus(index):
        adb('shell', '/data/local/tmp/parse-emulator-touch', 'next')
        # TalkBack may finish auto-scrolling and focus asynchronously. A .2s
        # snapshot raced the focus event and sent a second swipe past Cancel.
        time.sleep(.8)
        value = dump('talkback-focus-' + str(index))
        report['focus_sequence'].append({'at': now(), 'nodes': focused(value)})
        return value
    def double_tap():
        adb('shell', '/data/local/tmp/parse-emulator-touch', 'double')
    started = False
    try:
        assert {key: adb('shell', 'settings', 'get', 'secure', key).strip() for key in original} == original
        assert 'Physical size: 1080x2400' in adb('shell', 'wm', 'size')
        adb('shell', 'am', 'start', '-W', '-n', APP + '/sg.parse.companion.MainActivity')
        for _ in range(6):
            adb('shell', 'input', 'swipe', '980', '400', '980', '1950', '350')
        adb('shell', 'uiautomator', 'dump', '/sdcard/parse-talkback-before.xml')
        xml = adb('exec-out', 'cat', '/sdcard/parse-talkback-before.xml')
        node = next(n for n in ET.fromstring(xml).iter('node') if n.get('content-desc') == 'Use tap instead of hold to record')
        assert node.get('checked') == 'true' and node.get('enabled') == 'true'
        x1, y1, x2, y2 = map(int, re.findall(r'-?\d+', node.get('bounds')))
        assert y2 > y1
        adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
        adb('shell', 'uiautomator', 'dump', '/sdcard/parse-talkback-hold.xml')
        hold = adb('exec-out', 'cat', '/sdcard/parse-talkback-hold.xml')
        assert 'content-desc="Hold to talk"' in hold
        (OUT / 'talkback-probe-hold.xml').write_text(hold)
        report['virtual_touch_binary_sha256'] = digest(OUT / 'parse-emulator-touch')
        adb('push', str(OUT / 'parse-emulator-touch'), '/data/local/tmp/parse-emulator-touch')
        adb('shell', 'chmod', '700', '/data/local/tmp/parse-emulator-touch')
        adb('shell', 'settings', 'put', 'secure', 'tts_default_synth', 'com.reecedunn.espeak')
        adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', 'com.android.talkback/com.google.android.marvin.talkback.TalkBackService')
        adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1')
        for _ in range(100):
            ready = adb('shell', 'dumpsys', 'activity', 'service', 'TalkBackService', 'node_hierarchy', 'speech_controller')
            if 'CONTENT{Tap to start recording}' in ready and 'getVoice=Voice[Name: en-us' in ready: break
            time.sleep(.3)
        # First-time TalkBack onboarding can appear after service readiness.
        # Deliberately return to Parse and verify its foreground window before
        # injecting gestures; never navigate an unknown foreground activity.
        time.sleep(2)
        adb('shell', 'am', 'start', '-W', '-n', APP + '/sg.parse.companion.MainActivity')
        time.sleep(1)
        windows = adb('shell', 'dumpsys', 'window', 'displays')
        (OUT / 'talkback-foreground-window.txt').write_text(windows)
        focus = [line for line in windows.splitlines() if 'mCurrentFocus=' in line]
        assert len(focus) == 1 and APP in focus[0], 'Parse must own the foreground window'
        before = dump('talkback-probe-before')
        state = adb('shell', 'dumpsys', 'accessibility')
        (OUT / 'talkback-probe-accessibility.txt').write_text(state)
        assert 'touchExplorationEnabled=true' in state and 'TalkBack_TfP' in state
        assert 'getVoice=Voice[Name: en-us' in before and 'requiresNetwork: false' in before
        assert 'CONTENT{Tap to start recording}' in before
        switch = next(x for x in before.splitlines() if 'CONTENT{Use tap instead of hold to record}' in x)
        assert ':checked' in switch and ':disabled' in switch
        report['uploads_before'] = uploads()
        assert files() == []
        passed('Actual TalkBack and its offline English voice are active; the saved hold preference is overridden by accessible tap mode')
        # Touch-explore the visible wordmark, then traverse forward with real swipe gestures.
        adb('shell', '/data/local/tmp/parse-emulator-touch', 'logo')
        time.sleep(.35)
        for i in range(15):
            value = next_focus(i)
            if any('CONTENT{Tap to start recording}' in x for x in focused(value)):
                break
        else:
            raise AssertionError('Forward TalkBack gestures did not reach the recording button')
        assert files() == [] and uploads() == report['uploads_before']
        screenshot('talkback-record-control-focused')
        passed('TalkBack forward gestures reach the labelled recording button without starting capture')
        report['recording_gesture_at'] = now(); started = True
        double_tap()
        for i in range(8):
            value = dump('talkback-recording')
            if 'CONTENT{Recording. Tap to send.}' in value: break
            time.sleep(.2)
        assert 'CONTENT{Recording. Tap to send.}' in value, 'Double-tap did not start native recording'
        report['capture_files_during_recording'] = files()
        assert report['capture_files_during_recording']
        screenshot('talkback-recording')
        passed('A real TalkBack double-tap starts native recording and exposes the send label and transient capture file')
        deadline = time.monotonic() + 12
        for i in range(12):
            assert time.monotonic() < deadline, 'Cancel navigation must finish safely before the recording ceiling'
            value = next_focus(100 + i)
            if any('CONTENT{Cancel recording}' in x for x in focused(value)): break
        else:
            raise AssertionError('TalkBack forward gestures did not reach Cancel recording')
        screenshot('talkback-cancel-focused')
        double_tap()
        for i in range(8):
            value = dump('talkback-cancelled')
            if not files(): break
            time.sleep(.2)
        assert files() == []
        assert 'CONTENT{Recording. Tap to send.}' not in value
        assert uploads() == report['uploads_before']
        report['uploads_after'] = uploads(); report['capture_files_after'] = files()
        screenshot('talkback-cancelled')
        started = False
        passed('TalkBack gestures reach and activate Cancel; capture stops, cached audio is removed, and no upload is sent')
    except Exception as error:
        report['error'] = str(error)
        screenshot('talkback-probe-failure')
        raise
    finally:
        # On any failure, background immediately before inspecting/restoring settings.
        if started:
            adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
        for key, value in original.items():
            if value == 'null': adb('shell', 'settings', 'delete', 'secure', key)
            else: adb('shell', 'settings', 'put', 'secure', key, value)
        report['restored_settings'] = {key: adb('shell', 'settings', 'get', 'secure', key).strip() for key in original}
        # Restore the original persisted tap preference through Parse's actual UI.
        adb('shell', 'am', 'start', '-W', '-n', APP + '/sg.parse.companion.MainActivity')
        # A TalkBack auto-scroll can leave the long page several screens down.
        for _ in range(6):
            adb('shell', 'input', 'swipe', '980', '400', '980', '1950', '350')
        for i in range(8):
            adb('shell', 'uiautomator', 'dump', '/sdcard/parse-talkback-restore.xml')
            xml = adb('exec-out', 'cat', '/sdcard/parse-talkback-restore.xml')
            (OUT / 'talkback-restored.xml').write_text(xml)
            matches = [n for n in ET.fromstring(xml).iter('node') if n.get('content-desc') == 'Use tap instead of hold to record']
            if matches:
                node = matches[0]; x1, y1, x2, y2 = map(int, re.findall(r'-?\d+', node.get('bounds')))
                if y2 > y1 and node.get('enabled') == 'true':
                    if node.get('checked') == 'true': break
                    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2)); continue
            adb('shell', 'input', 'swipe', '980', '1700', '980', '1300', '250')
        else:
            report['restoration_error'] = 'Could not restore the saved tap preference'
        report['tap_preference_restored'] = node.get('checked') == 'true' if matches else False
        report['capture_files_at_cleanup'] = files()
        screenshot('talkback-restored')
        save()
        assert report['restored_settings'] == original
        assert report['tap_preference_restored']
        assert files() == []

if __name__ == '__main__':
    main()
