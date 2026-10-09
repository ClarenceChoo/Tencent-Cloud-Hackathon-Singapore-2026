import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = new URL('../', import.meta.url);
const bundle = await build({ entryPoints: [fileURLToPath(new URL('app/care/care-backend.ts', root))], bundle: true, write: false, format: 'esm', target: 'es2022' });
const { serveCare } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('activity test')}}", compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'], host: '127.0.0.1', port: 0 });
const checks = [];
try {
  const DB = await mf.getD1Database('DB'), BUCKET = await mf.getR2Bucket('BUCKET');
  for (const name of (await readdir(new URL('drizzle/', root))).filter(name => name.endsWith('.sql')).sort())
    for (const sql of (await readFile(new URL(`drizzle/${name}`, root), 'utf8')).split('--> statement-breakpoint')) if (sql.trim()) await DB.prepare(sql).run();
  const origin = 'https://activity-test.example';
  const owner = { userId: 'owner', email: 'owner@example.test' }, peer = { userId: 'peer', email: 'peer@example.test' };
  const bindings = { DB, BUCKET, PUBLIC_SITE_ORIGIN: origin, DASHBOARD_ALLOWED_EMAILS: `${owner.email},${peer.email}` };
  async function req(path, { user = owner, data, method } = {}) {
    const headers = { Origin: origin, 'X-CSRF-Token': 'parse-care', 'Content-Type': 'application/json' };
    return serveCare(new Request(`${origin}/v1/${path}`, { method: method || (data ? 'POST' : 'GET'), headers, ...(data ? { body: JSON.stringify(data) } : {}) }), user, bindings);
  }
  async function json(response, expected = 200) { assert.equal(response.status, expected, await response.clone().text()); return response.json(); }
  const session = await json(await req('auth/session')), patient = session.patients[0].id, prefix = `app/patients/${patient}`;
  const log = (query = '', options) => req(`${prefix}/activity${query}`, options);
  assert.equal((await log('', { user: null })).status, 401);
  assert.equal((await log('', { user: { userId: 'outside', email: 'outside@example.test' } })).status, 403);
  assert.equal((await log('', { user: peer })).status, 404);
  assert.equal((await log('', { method: 'POST', data: {} })).status, 404);
  const grant = await json(await req(`${prefix}/grants`, { data: { user_id: peer.email, scopes: ['read:notes', 'read:measurements'] } }), 201);

  let workspace = await DB.prepare('SELECT state_json FROM care_workspaces WHERE owner_id = ?').bind(owner.userId).first();
  const state = JSON.parse(workspace.state_json), at = '2026-10-08T16:00:00.000Z';
  state.notes = [
    { id: 'private-note', wording: 'SECRET_PRIVATE_NOTE', created_at: at, shared_with_user_ids: [] },
    { id: 'shared-note', wording: 'SHARED_NOTE marker', created_at: at, shared_with_user_ids: [peer.email], version: 1 },
    { id: 'deleted-note', wording: 'SECRET_DELETED_NOTE', created_at: at, deleted_at: at, shared_with_user_ids: [peer.email] },
    { id: 'prior-day', wording: 'Prior Singapore day', created_at: '2026-10-08T15:59:59.999Z', shared_with_user_ids: [] },
  ];
  state.measurements = [{ id: 'reading', systolic: 120, diastolic: 80, unit: 'mmHg', source_description: 'Fictional monitor', confirmed_at: at }];
  state.doses = Array.from({ length: 130 }, (_, index) => ({ id: `dose-${String(index).padStart(3, '0')}`, medicine_name: 'History medicine', report_state: 'reported_taken', report_time: new Date(Date.parse(at) - index * 86400000).toISOString() }));
  state.doses.push({ id: 'unreported-dose', medicine_name: 'UNREPORTED_MARKER', report_state: 'unconfirmed', scheduled_at: at });
  state.doses.push({ id: 'revised-dose', medicine_name: 'REVISION_MEDICINE', report_state: 'reported_taken', report_time: at,
    report_history: [{ id: 'first-report', report_time: '2026-10-07T00:00:00Z', report_state: 'reported_not_yet' }, { id: 'second-report', report_time: at, report_state: 'reported_taken' }] });
  state.support_requests = [{ id: 'other-request', recipient_user_id: owner.email, request_text: 'SECRET_OTHER_REQUEST', created_at: at }];
  state.followups = [{ id: 'private-related', related_type: 'health_note', related_id: 'private-note', permitted_user_ids: [peer.email], description: 'SECRET_PRIVATE_FOLLOWUP', created_at: at }];
  state.proposals = [{ id: 'private-proposal', kind: 'health_note', status: 'pending', created_at: at, readback: 'SECRET_DELETED_NOTE', payload: { wording: 'SECRET_DELETED_NOTE' } }];
  state.summaries = [{ id: 'private-summary', created_at: at, sections: [{ text: 'SECRET_DELETED_NOTE' }], url: 'SECRET_SHARE_TOKEN' }];
  await DB.prepare('UPDATE care_workspaces SET state_json = ? WHERE owner_id = ?').bind(JSON.stringify(state), owner.userId).run();
  const now = Date.parse(at);
  await DB.prepare("INSERT INTO voice_rooms (id,owner_id,invitation_hash,state,created_at,expires_at,updated_at) VALUES ('room',?,'SECRET_INVITATION','paired',?,?,?)").bind(owner.userId, now, now + 86400000, now).run();
  await DB.prepare("INSERT INTO voice_recordings (id,room_id,owner_id,state,next_sequence,frames,created_at,updated_at,transcript,error_code) VALUES ('recording','room',?,'ready',1,16000,?,?, 'SECRET_TRANSCRIPT','SECRET_PROVIDER_ERROR')").bind(owner.userId, now, now).run();

  const peerPage = await json(await log('', { user: peer })), peerText = JSON.stringify(peerPage);
  assert(peerPage.items.some(row => row.record_id === 'shared-note'));
  assert(peerPage.items.some(row => row.record_id === 'reading'));
  for (const secret of ['SECRET_', 'History medicine', 'private-proposal', 'private-summary', 'recording']) assert(!peerText.includes(secret), secret);
  const ownerPage = await json(await log('?category=notes&limit=100'));
  assert(ownerPage.items.some(row => row.record_id === 'private-note'));
  assert(!JSON.stringify(ownerPage).includes('SECRET_DELETED_NOTE'));
  const recordingPage = await json(await log('?category=recordings'));
  assert(recordingPage.items.some(row => row.record_id === 'recording'));
  assert(ownerPage.items.some(row => row.record_id === 'private-proposal'));
  assert(!recordingPage.items.some(row => row.record_id === 'private-proposal'));
  assert(!JSON.stringify(recordingPage).includes('SECRET_'));
  assert(!JSON.stringify(await json(await log('?category=summaries'))).includes('SECRET_'));
  checks.push('Current record permissions hide private/deleted notes, other recipients’ requests, related private follow-ups, proposals and audio metadata from shared viewers; no raw transcripts, tokens or provider errors enter the log.');

  const dayPage = await json(await log('?category=notes&start=2026-10-09&end=2026-10-09'));
  assert.equal(dayPage.timezone, 'Asia/Singapore');
  assert(dayPage.items.some(row => row.record_id === 'shared-note'));
  assert(!dayPage.items.some(row => row.record_id === 'prior-day'));
  const searched = await json(await log('?search=shared_note&category=notes'));
  assert.deepEqual(searched.items.map(row => row.record_id), ['shared-note']);
  for (const query of ['?start=2026-02-30', '?start=2026-10-10&end=2026-10-09', '?category=invalid', '?limit=101', '?limit=0', '?limit=1.5', '?cursor=not-a-cursor', `?search=${'x'.repeat(201)}`]) assert.equal((await log(query)).status, 422, query);
  checks.push('Search, category, calendar validation and Singapore midnight boundaries are applied on the server.');

  let cursor = '', all = [], pages = 0;
  do {
    const page = await json(await log(`?category=medications&limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    assert(page.items.length <= 17); all.push(...page.items); cursor = page.next_cursor; pages++;
    assert(pages < 20);
  } while (cursor);
  assert.equal(all.filter(row => row.summary.includes('History medicine')).length, 130);
  assert.equal(all.filter(row => row.record_id === 'revised-dose').length, 2);
  assert(!all.some(row => row.record_id === 'unreported-dose'));
  assert.equal(new Set(all.map(row => row.id)).size, all.length);
  const first = await json(await log('?category=notes&limit=1'));
  assert(first.next_cursor);
  assert.equal((await log(`?category=readings&cursor=${encodeURIComponent(first.next_cursor)}`)).status, 422);
  const repeated = await json(await log(`?category=notes&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`));
  assert.notEqual(repeated.items[0].id, first.items[0].id);
  checks.push('Stable pagination includes more than 100 historical doses, preserves recorded revisions, omits unreported doses and handles timestamp ties without duplicates.');

  await json(await req('app/notes/shared-note/sharing', { method: 'PUT', data: { user_ids: [] } }));
  assert(!(await json(await log('', { user: peer }))).items.some(row => row.record_id === 'shared-note'));
  await json(await req(`app/grants/${grant.id}`, { method: 'DELETE' }));
  assert.equal((await log('', { user: peer })).status, 404);
  checks.push('Removing note sharing or the care grant takes effect on the next log request.');
  console.log(JSON.stringify({ passed: true, checks, pages, realApiRequests: 0, microphoneRecorded: false }, null, 2));
} finally { await mf.dispose(); }
