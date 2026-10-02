"""Actual Firefox Android summary journey on the disposable native fixture.

Prerequisites: paired verification app, Firefox 156.0.1 onboarded, and the
127.0.0.1:8443 fixture certificate accepted in that browser only. No personal
browser/device, live care service or production credential is accepted here.
"""
from pathlib import Path
import hashlib
import http.cookiejar
import json
import re
import sqlite3
import ssl
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'runtime/android-browser'
FIXTURE = ROOT / 'runtime/native-care-20260927'
ADB = ROOT / 'runtime/android-build/sdk/platform-tools/adb'
SERIAL = 'emulator-5580'
BROWSER = 'org.mozilla.firefox'
APP = 'sg.parse.companion.verification'
ORIGIN = 'https://127.0.0.1:8443'
REPORT = OUT / 'android-browser-summary-evidence.json'
report = {'at': datetime.now(timezone.utc).isoformat(), 'physicalPhone': False,
          'nativeBrowser': True, 'liveSpeech': False, 'checks': [],
          'environment': 'Firefox Android in the Android 16 ARM64 emulator; existing fictional native care records and local HTTPS. Browser-only exception for the fixture certificate; no release TLS change.',
          'source_sha256': {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in [
              'tools/android_browser_summary.py', 'mobile/src/App.tsx', 'frontend/src/App.tsx',
              'frontend/src/api.ts', 'frontend/src/useSharedSummary.ts', 'frontend/src/__tests__/public-summary-access.test.tsx', 'frontend/src/styles.css', 'backend/app/main.py',
              'backend/app/services.py', 'tools/android_native_fixture.py']}}


def adb(*args):
    return subprocess.run([str(ADB), '-s', SERIAL, *args], check=True,
                          capture_output=True, timeout=30).stdout


def ui():
    adb('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/parse-browser-ui.xml')
    raw = adb('exec-out', 'cat', '/sdcard/parse-browser-ui.xml')
    (OUT / 'ui.xml').write_bytes(raw)
    return [n.attrib for n in ET.fromstring(raw).iter('node')]


def match(nodes, label):
    for n in nodes:
        if label in [n.get('text'), n.get('content-desc'), n.get('resource-id')]:
            x1, y1, x2, y2 = map(int, re.findall(r'\d+', n['bounds']))
            if x2 > x1 and y2 > y1:
                return n
    return None


def wait(label):
    for _ in range(8):
        nodes = ui()
        tip = match(nodes, 'Shake your device to summarize this page in seconds. ⚡️')
        dismiss = match(nodes, 'Dismiss')
        if label != 'Dismiss' and tip is not None and dismiss is not None and dismiss.get('package') == BROWSER:
            tap_node(dismiss)
            report['firefox_tip_dismissed'] = True
            continue
        node = match(nodes, label)
        if node is not None:
            return node
    raise AssertionError('Control unavailable: ' + label)


def tap_node(node):
    assert node['enabled'] == 'true'
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node['bounds']))
    adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def tap(label):
    tap_node(wait(label))


def key(value):
    adb('shell', 'input', 'keyevent', str(value))


def shot(name):
    ui()
    (OUT / (name + '.xml')).write_bytes((OUT / 'ui.xml').read_bytes())
    (OUT / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))


def save():
    REPORT.write_text(json.dumps(report, indent=2) + '\n')


def passed(name):
    report['checks'].append({'name': name, 'passed': True})
    save()
    print('PASS ' + name, flush=True)


def open_url(url):
    assert url.startswith(ORIGIN + '/') or url == ORIGIN
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, '-p', BROWSER)


def login(role):
    assert role in ['owner', 'restricted']
    def fill(label, text):
        tap(label)
        time.sleep(0.3)
        adb('shell', 'input', 'keycombination', '113', '29')
        key(67)
        for character in text:
            adb('shell', 'input', 'text', character)
            time.sleep(0.08)
        key(4)
    email = role + '@native.invalid'
    fill('Email address', email)
    assert any(n.get('class') == 'android.widget.EditText' and n.get('text') == email for n in ui()), 'Fixture email was not entered exactly'
    fill('Password', 'fictional-native-only')
    tap('Continue →')
    nodes = ui()
    if match(nodes, 'Never save') is not None:
        tap('Never save')
    wait('Open menu')


def rows(sql, args=()):
    with sqlite3.connect('file:' + str(FIXTURE / 'fixture.db') + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(sql, args)]


def snapshot():
    records = {}
    for table in ['health_notes', 'measurements', 'preventive_tasks', 'support_requests', 'followups', 'voice_turns']:
        data = rows('select * from ' + table + ' order by id')
        records[table] = {'count': len(data), 'sha256': hashlib.sha256(json.dumps(data, sort_keys=True, default=lambda value: hashlib.sha256(value).hexdigest()).encode()).hexdigest()}
    return {'records': records,
            'routes': rows('select * from companion_routes'),
            'uploads': len((FIXTURE / 'native-uploads.jsonl').read_text().splitlines())}


def summary():
    data = rows('select id,status,sections,source_refs,omitted_source_ids,reviewed_at from visit_summaries order by created_at desc limit 1')[0]
    for field in ['sections', 'source_refs', 'omitted_source_ids']:
        data[field] = json.loads(data[field])
    return data


def native_tap(label):
    for attempt in range(12):
        n = match(ui(), label)
        if n is not None and n['enabled'] == 'true':
            tap_node(n)
            return
        adb('shell', 'input', 'swipe', '970', '650' if attempt < 5 else '1900',
            '970', '1900' if attempt < 5 else '650', '300')
    raise AssertionError('Native control unavailable: ' + label)


csrf = None
api = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
                                 urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(FIXTURE / 'tls/ca.pem'))))


def post(route, data):
    headers = {'Origin': ORIGIN, 'Content-Type': 'application/json'}
    if csrf:
        headers['X-CSRF-Token'] = csrf
    response = api.open(urllib.request.Request(ORIGIN + route, json.dumps(data).encode(), headers), timeout=15)
    raw = response.read()
    return json.loads(raw) if raw else None


def main():
    global csrf
    assert json.loads((FIXTURE / 'fixture.json').read_text())['origin'] == ORIGIN
    assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() == b'1'
    assert adb('shell', 'getprop', 'ro.build.version.sdk').strip() == b'36'
    OUT.mkdir(exist_ok=True)
    before = snapshot()
    report['before'] = before
    for package, field in [(APP, 'parse_apk_sha256'), (BROWSER, 'browser_apk_sha256')]:
        installed = adb('shell', 'pm', 'path', package).decode().strip().removeprefix('package:')
        assert installed.startswith('/data/app/') and '\n' not in installed
        report[field] = adb('shell', 'sha256sum', installed).decode().split()[0]
    assert report['browser_apk_sha256'] == 'a37ac4de7b61c79dad5c1b639d9bd3afbe18f6b781a56759dbb8bb0d394f8957'
    report['served_frontend_index_sha256'] = hashlib.sha256(api.open(ORIGIN, timeout=15).read()).hexdigest()
    assert report['served_frontend_index_sha256'] == hashlib.sha256((ROOT / 'frontend/dist/index.html').read_bytes()).hexdigest()
    report['browser'] = 'Firefox Android 156.0.1 (2016185922), official Mozilla ARM64 APK'
    # This role replaces only the documented original WebView Shell on the fixture emulator.
    adb('shell', 'cmd', 'role', 'add-role-holder', '--user', '0', 'android.app.role.BROWSER', BROWSER)
    try:
        open_url(ORIGIN)
        tap('More options'); tap('Refresh')
        nodes = ui()
        if match(nodes, 'Shake your device to summarize this page in seconds. ⚡️') is not None:
            tap('Dismiss')
            report['firefox_tip_dismissed'] = True
            nodes = ui()
        if match(nodes, 'Sign out') is not None:
            tap('Sign out')
        wait('Sign in to your care space')
        adb('shell', 'am', 'start', '-W', '-n', APP + '/sg.parse.companion.MainActivity')
        native_tap('Settings'); native_tap('Open care dashboard')
        tap('More options'); tap('Refresh')
        wait('Sign in to your care space'); shot('browser-login')
        passed('Native dashboard button opens Firefox with separate browser sign-in, without inheriting device authority')
        login('owner'); tap('Open menu'); tap('Visit summary')
        nodes = ui()
        button = match(nodes, 'Prepare a fresh draft') or match(nodes, 'Prepare draft')
        assert button is not None
        tap_node(button); key(93)
        wait('health_note · version 1')
        draft = summary(); sid = draft['id']
        report['summary_id'] = sid
        omit = draft['sections'][0]['items'][0]
        keep = draft['sections'][0]['items'][1]
        report['source_notes'] = {'omitted': omit['source_id'], 'retained': keep['source_id']}
        provenance = rows('select d.device_type,t.id as turn_id from health_notes n join confirmation_proposals p on p.id=n.proposal_id join voice_turns t on t.id=p.source_turn_id join devices d on d.id=t.device_id where n.id=?', (omit['source_id'],))[0]
        assert provenance['device_type'] == 'phone'
        report['omitted_note_provenance'] = provenance
        shot('browser-review')
        checkbox = next(n for n in ui() if n.get('class') == 'android.widget.CheckBox' and n.get('text') == 'health_note · version 1')
        assert checkbox['checked'] == 'true'; tap_node(checkbox); shot('browser-omission')
        key(123)
        share = wait('Share read-only'); assert share['enabled'] == 'false'; shot('browser-unreviewed')
        tap('Save review')
        for _ in range(6):
            share = wait('Share read-only')
            if share['enabled'] == 'true': break
        assert share['enabled'] == 'true'
        reviewed = summary()
        assert reviewed['id'] == sid and reviewed['reviewed_at'] and reviewed['omitted_source_ids'] == [omit['source_id']]
        shot('browser-reviewed')
        passed('Owner omits a phone-sourced note; Share remains disabled until the deliberate review is saved')
        tap('Share read-only'); wait('Open read-only view'); shot('browser-share')
        tap('Open read-only view'); wait(keep['text'])
        xml = ET.parse(OUT / 'ui.xml')
        content = next(n for n in xml.iter('node') if n.attrib.get('class') == 'android.webkit.WebView')
        assert not any(n.attrib.get('class') in ['android.widget.EditText', 'android.widget.Button', 'android.widget.CheckBox'] for n in content.iter('node'))
        address = next(n for n in ui() if n.get('resource-id') == 'ADDRESSBAR_URL_BOX')['content-desc']
        token = re.search(r'127\.0\.0\.1:8443/shared/summaries/([A-Za-z0-9_-]+)', address).group(1)
        public_url = ORIGIN + '/shared/summaries/' + token
        public = json.load(urllib.request.urlopen(ORIGIN + '/v1/shared/summaries/' + token,
                          context=ssl.create_default_context(cafile=str(FIXTURE / 'tls/ca.pem')), timeout=15))
        encoded = json.dumps(public)
        assert omit['text'] not in encoded and keep['text'] in encoded
        shot('browser-public')
        passed('Android Firefox renders the shared read-only summary; unauthenticated public response retains the selected note and excludes the omitted statement')
        key(4); tap('Revoke link'); shot('browser-owner-revoked')
        open_url(public_url); wait('This summary is unavailable'); shot('browser-revoked')
        report['revoked_shares'] = rows('select id,revoked_at from summary_shares where summary_id=?', (sid,))
        assert report['revoked_shares'] and all(s['revoked_at'] for s in report['revoked_shares'])
        passed('Owner revokes in Android Firefox; reopening the original public link shows unavailable')
        # API setup makes only this test share short-lived; the browser observes actual expiry.
        csrf = post('/v1/auth/login', {'email': 'owner@native.invalid', 'password': 'fictional-native-only'})['csrf_token']
        expiring = post('/v1/app/summaries/' + sid + '/share', {'expires_in_seconds': 60})
        expiry_url = ORIGIN + expiring['url'].removeprefix('/v1')
        open_url(expiry_url); wait(keep['text']); shot('browser-expiry-before')
        deadline = datetime.fromisoformat(expiring['expires_at'].replace('Z', '+00:00')).timestamp() + 1
        print('Waiting for the real 60-second share expiry', flush=True)
        while time.time() < deadline: time.sleep(max(0, min(1, deadline - time.time())))
        wait('This summary is unavailable'); shot('browser-expired')
        assert not any(keep['text'] in n.get('text', '') for n in ui())
        report['expiry'] = {'expires_at': expiring['expires_at'], 'observed_at': datetime.now(timezone.utc).isoformat(), 'clock_override': False, 'page_reload_at_expiry': False, 'setup': 'Authenticated fixture-owner API creates the separate 60-second share; Android browser performs both reads'}
        passed('An open Android Firefox summary automatically clears after actual server-clock expiry, without reload or navigation')
        open_url(ORIGIN); wait('Sign out'); tap('Sign out'); wait('Sign in to your care space')
        login('restricted'); tap('Open menu'); tap('Visit summary'); wait('Summary sharing is owner managed')
        nodes = ui()
        assert all(match(nodes, label) is None for label in ['Prepare draft', 'Prepare a fresh draft', 'Share read-only', 'Save review'])
        shot('browser-restricted'); key(122); tap('Sign out'); wait('Sign in to your care space')
        passed('Restricted caregiver browser sign-in exposes no summary preparation or sharing actions; test session signs out')
        after = snapshot(); assert before == after
        report['after'] = after
        passed('Existing care records, voice turns, uploads and the selected reminder route remain unchanged')
    except Exception as error:
        report['failure'] = str(error)
        save()
        raise
    finally:
        if csrf:
            post('/v1/auth/logout', {})
        adb('shell', 'cmd', 'role', 'add-role-holder', '--user', '0', 'android.app.role.BROWSER', 'org.chromium.webview_shell')
        restored = adb('shell', 'cmd', 'role', 'get-role-holders', '--user', '0', 'android.app.role.BROWSER').decode().strip()
        report['default_browser_restored'] = restored
        assert restored == 'org.chromium.webview_shell'
        adb('shell', 'am', 'start', '-W', '-n', APP + '/sg.parse.companion.MainActivity')
        save()


if __name__ == '__main__':
    main()
