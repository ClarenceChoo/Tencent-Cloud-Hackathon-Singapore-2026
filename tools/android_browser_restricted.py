"""Finish the restricted-user check after the preserved five-check native run.

This accepts only the documented post-expiry checkpoint, verifies its unchanged
product sources/APKs/care state, and records new checks separately from inherited
ones. It does not claim to rerun the earlier review/share/expiry interactions.
"""
import hashlib
import json
from datetime import datetime, timezone
import android_browser_summary as b

checkpoint = b.OUT / 'android-browser-summary-fixed-checkpoint.json'
prior = json.loads(checkpoint.read_text())
assert len(prior['checks']) == 5 and all(c['passed'] for c in prior['checks'])
assert prior['failure'] == 'Control unavailable: Open menu'
assert prior['expiry']['page_reload_at_expiry'] is False
for file, digest in prior['source_sha256'].items():
    if file != 'tools/android_browser_summary.py':
        assert hashlib.sha256((b.ROOT / file).read_bytes()).hexdigest() == digest, file
assert b.adb('shell', 'getprop', 'ro.kernel.qemu').strip() == b'1'
for package, field in [(b.APP, 'parse_apk_sha256'), (b.BROWSER, 'browser_apk_sha256')]:
    installed = b.adb('shell', 'pm', 'path', package).decode().strip().removeprefix('package:')
    assert installed.startswith('/data/app/') and '\n' not in installed
    assert b.adb('shell', 'sha256sum', installed).decode().split()[0] == prior[field]
assert b.snapshot() == prior['before']
report = {'at': datetime.now(timezone.utc).isoformat(), 'nativeBrowser': True, 'physicalPhone': False,
          'checkpoint_sha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
          'inherited_checks': prior['checks'], 'inherited_source_sha256': prior['source_sha256'],
          'source_sha256': {p: hashlib.sha256((b.ROOT / p).read_bytes()).hexdigest() for p in [
              'tools/android_browser_restricted.py', 'tools/android_browser_summary.py',
              'frontend/src/App.tsx', 'frontend/src/useSharedSummary.ts', 'frontend/src/api.ts']},
          'before': prior['before'], 'checks': [], 'limits': 'Continuation of a documented Android emulator checkpoint. Initial email injection failed; no restricted login succeeded in that run. Physical phones and iOS remain unverified.'}
output = b.OUT / 'android-browser-summary-continuation.json'
def save(): output.write_text(json.dumps(report, indent=2) + '\n')
def passed(name):
    report['checks'].append({'name': name, 'passed': True}); save(); print('PASS ' + name, flush=True)
b.adb('shell', 'cmd', 'role', 'add-role-holder', '--user', '0', 'android.app.role.BROWSER', b.BROWSER)
try:
    b.open_url(b.ORIGIN); b.tap('More options'); b.tap('Refresh')
    nodes = b.ui()
    if b.match(nodes, 'Sign out') is not None: b.tap('Sign out')
    b.wait('Sign in to your care space')
    b.login('restricted'); b.tap('Open menu'); b.tap('Visit summary')
    b.wait('Summary sharing is owner managed')
    nodes = b.ui()
    assert all(b.match(nodes, label) is None for label in ['Prepare draft', 'Prepare a fresh draft', 'Share read-only', 'Save review'])
    b.shot('browser-restricted')
    b.key(122); b.tap('Sign out'); b.wait('Sign in to your care space')
    passed('Restricted caregiver signs in through Android Firefox, has no summary preparation/sharing controls, and signs out')
    report['after'] = b.snapshot()
    assert report['after'] == prior['before']
    passed('All care-record and voice-turn hashes, upload count and reminder route remain unchanged across the full checkpoint and continuation')
except Exception as error:
    report['failure'] = str(error); save(); raise
finally:
    b.adb('shell', 'cmd', 'role', 'add-role-holder', '--user', '0', 'android.app.role.BROWSER', 'org.chromium.webview_shell')
    restored = b.adb('shell', 'cmd', 'role', 'get-role-holders', '--user', '0', 'android.app.role.BROWSER').decode().strip()
    assert restored == 'org.chromium.webview_shell'
    report['default_browser_restored'] = restored
    b.adb('shell', 'am', 'start', '-W', '-n', b.APP + '/sg.parse.companion.MainActivity')
    save()
