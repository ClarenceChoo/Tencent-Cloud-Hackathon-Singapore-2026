/* Read-only observers for a fictional native TalkBack care journey. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const directory = path.resolve(process.argv[2]);
assert(directory.startsWith(path.join(root, 'runtime') + path.sep));
const fixture = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json')));
assert.equal(new URL(fixture.origin).hostname, '127.0.0.1');
const wording = JSON.parse(process.argv[3]);
assert(wording.original.startsWith('Fictional TalkBack ') && wording.corrected.startsWith('Fictional TalkBack '));
const output = path.join(root, 'runtime/android-accessibility');
const ids = notes => notes.map(n => n.id).sort();
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  async function login(role) {
    const context = await browser.newContext({ baseURL: fixture.origin, ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto('/');
    await page.getByLabel('Email address').fill(role + '@native.invalid');
    await page.getByLabel('Password', { exact: true }).fill('fictional-native-only');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('heading', { name: /care timeline/i }).waitFor();
    return { page, async dash() {
      const response = await context.request.get(`/v1/app/patients/${fixture.patient_id}/dashboard`);
      assert(response.ok());
      return response.json();
    } };
  }
  try {
    const clients = {};
    for (const role of ['owner', 'caregiver', 'restricted']) clients[role] = await login(role);
    const baseline = {};
    for (const [role, client] of Object.entries(clients)) baseline[role] = ids((await client.dash()).notes);
    emit({ ready: true, at: new Date().toISOString(), browser: browser.version(), baseline });
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      const { op } = JSON.parse(line);
      if (op === 'close') { emit({ closed: true }); break; }
      assert(['unsaved', 'saved'].includes(op));
      if (op === 'unsaved') {
        for (const [role, client] of Object.entries(clients)) {
          assert.deepEqual(ids((await client.dash()).notes), baseline[role]);
          for (const text of Object.values(wording))
            assert.equal(await client.page.getByRole('heading', { name: text, exact: true }).count(), 0);
        }
        emit({ unsaved: true, at: new Date().toISOString() });
        continue;
      }
      // These pages have stayed open since before capture. Do not reload them.
      await clients.caregiver.page.getByRole('heading', { name: wording.corrected, exact: true }).waitFor();
      await clients.restricted.page.waitForResponse(r => r.ok() && new URL(r.url()).pathname.endsWith('/dashboard'));
      const owner = await clients.owner.dash();
      const matches = owner.notes.filter(n => n.wording === wording.corrected);
      assert.equal(matches.length, 1);
      const note = matches[0];
      assert.deepEqual(ids(owner.notes), [...baseline.owner, note.id].sort());
      assert.equal(note.provenance.type, 'phone');
      assert.deepEqual(note.shared_with_user_ids, [fixture.caregiver_id]);
      assert(!owner.notes.some(n => n.wording === wording.original));
      assert((await clients.caregiver.dash()).notes.some(n => n.id === note.id));
      assert.deepEqual(ids((await clients.restricted.dash()).notes), baseline.restricted);
      assert.equal(await clients.restricted.page.getByRole('heading', { name: wording.corrected, exact: true }).count(), 0);
      await clients.caregiver.page.screenshot({ path: path.join(output, 'talkback-care-caregiver.png'), fullPage: true });
      await clients.restricted.page.screenshot({ path: path.join(output, 'talkback-care-restricted.png'), fullPage: true });
      emit({ saved: true, at: new Date().toISOString(), note, caregiver_visible: true,
        restricted_visible: false, owner_note_count: owner.notes.length, pages_reloaded: false });
    }
  } finally {
    process.stdin.destroy();
    await browser.close();
  }
}
main().catch(error => { emit({ error: String(error) }); process.exitCode = 1; });
