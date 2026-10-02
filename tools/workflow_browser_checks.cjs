/* Real browser checks against the disposable, fictional same-origin fixture. */
const assert = require('node:assert/strict');

async function checkFirstUse({ page, uploads, pass }) {
  const guide = page.getByRole('region', { name: 'First-use guide' });
  const before = uploads();
  await guide.getByText('See a static example first', { exact: true }).click();
  await guide.getByText('Demonstration only.', { exact: true }).waitFor();
  assert.equal(uploads(), before);
  await guide.getByRole('button', { name: 'Play speaker check', exact: true }).click();
  await guide.getByRole('button', { name: 'Check microphone permission', exact: true }).waitFor();
  await guide.getByRole('button', { name: 'Check microphone permission', exact: true }).click();
  await guide.getByRole('button', { name: 'Start first update', exact: true }).waitFor();
  assert.equal(uploads(), before, 'Speaker/microphone exercise uploaded a turn');
  assert(await page.evaluate(() => window.__parseObservedTracks.every(track => track.readyState === 'ended')));
  await guide.getByRole('button', { name: 'Start first update', exact: true }).focus();
  await page.keyboard.press('Enter');
  pass('The static tutorial and speaker/microphone checks create no update; microphone tracks end and the first update starts deliberately');
}

async function checkFirstUpdateSaved({ page, pass }) {
  const guide = page.getByRole('region', { name: 'First-use guide' });
  await guide.getByRole('heading', { name: 'Your first update is saved', exact: true }).waitFor();
  assert(await guide.getByText(/Live voice has not been verified/).count());
  pass('The first-use guide requires a confirmed record and keeps simulated speech distinct from live voice verification');
}

async function checkAskParse({ owner, caregiver, restricted, fixture, nav, pass }) {
  await nav(owner.page, 'Ask Parse');
  const ask = owner.page.getByRole('region', { name: 'Ask Parse', exact: true });
  await ask.getByRole('button', { name: 'Find answer', exact: true }).focus();
  await owner.page.keyboard.press('Enter');
  const answer = ask.locator('.ask-parse-answer');
  await answer.waitFor();
  if ((await owner.dash()).measurements.length) {
    await answer.getByText('Occurred: Unknown', { exact: true }).waitFor();
    await answer.getByRole('button', { name: 'View source', exact: true }).click();
    await owner.page.getByRole('heading', { name: /care timeline/i }).waitFor();
    assert.match(await owner.page.evaluate(() => document.activeElement?.getAttribute('data-action-source') || ''), /^measurement:/);
  } else {
    await answer.getByText('No confirmed blood-pressure reading is available to you.', { exact: true }).waitFor();
  }
  await nav(owner.page, 'Ask Parse');
  await ask.getByLabel('Question', { exact: true }).selectOption('open_support');
  await ask.getByRole('button', { name: 'Find answer', exact: true }).click();
  await answer.locator('.ask-parse-results > li').first().waitFor();
  assert.equal(await answer.locator('.ask-parse-results > li').count(), 1);
  await nav(caregiver.page, 'Ask Parse');
  const caregiverAsk = caregiver.page.getByRole('region', { name: 'Ask Parse', exact: true });
  await caregiverAsk.getByLabel('Question', { exact: true }).selectOption('open_support');
  await caregiverAsk.getByRole('button', { name: 'Find answer', exact: true }).click();
  await caregiverAsk.locator('.ask-parse-results > li').first().waitFor();
  assert.equal(await caregiverAsk.locator('.ask-parse-results > li').count(), 1);

  const dose = (await owner.dash()).doses.find(row => row.id === fixture.dose_id);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dose.scheduled_at));
  await ask.getByLabel('Question', { exact: true }).selectOption('medication_reports');
  await ask.getByLabel('Scheduled date in Asia/Singapore', { exact: true }).fill(day);
  await ask.getByRole('button', { name: 'Find answer', exact: true }).click();
  await answer.getByText(/Reported not yet/).waitFor();
  assert(!/missed/i.test(await answer.textContent()));
  await answer.getByRole('button', { name: 'View source', exact: true }).click();
  await owner.page.getByRole('heading', { name: 'Medications', exact: true }).waitFor();
  assert.equal(await owner.page.evaluate(() => document.activeElement?.getAttribute('data-action-source')), `dose:${fixture.dose_id}`);

  await owner.api('/app/patients/' + fixture.patient_id + '/grants', { user_id: fixture.restricted_id, scopes: ['read:measurements'] });
  await nav(restricted.page, 'Ask Parse');
  const restrictedAsk = restricted.page.getByRole('region', { name: 'Ask Parse', exact: true });
  await restrictedAsk.getByLabel('Question', { exact: true }).selectOption('open_support');
  await restrictedAsk.getByRole('button', { name: 'Find answer', exact: true }).click();
  await restrictedAsk.getByText('You do not have permission to view this category.', { exact: true }).waitFor();
  assert.equal(await restrictedAsk.locator('.ask-parse-results > li').count(), 0);
  assert.equal((await restricted.dash()).support_requests.length, 0);

  await nav(owner.page, 'Ask Parse');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let acceptedResolve;
  const accepted = new Promise(resolve => { acceptedResolve = resolve; });
  const delayedRoute = '**/v1/app/patients/' + fixture.patient_id + '/queries';
  await owner.page.route(delayedRoute, async route => {
    const response = await route.fetch(); acceptedResolve(); await held;
    try { await route.fulfill({ response }); } catch { /* The switched component intentionally aborts. */ }
  }, { times: 1 });
  await ask.getByRole('button', { name: 'Find answer', exact: true }).click();
  await accepted;
  await owner.page.getByLabel('Choose patient profile', { exact: true }).selectOption(fixture.second_patient_id);
  await owner.page.waitForFunction(() => document.querySelector('#ask-parse-question')?.value === 'latest_reading');
  assert.equal(await ask.getByLabel('Question', { exact: true }).inputValue(), 'latest_reading');
  release(); await owner.page.unroute(delayedRoute);
  await ask.getByRole('button', { name: 'Find answer', exact: true }).click();
  await ask.getByText('No confirmed blood-pressure reading is available to you.', { exact: true }).waitFor();
  assert.equal(await ask.getByText('Example medicine', { exact: true }).count(), 0);
  await owner.page.getByLabel('Choose patient profile', { exact: true }).selectOption(fixture.patient_id);
  pass('Ask Parse distinguishes unknown, empty and forbidden evidence, revalidates and focuses sources, and drops a delayed answer on care-space change');
}

async function checkCaregiverRevocation({ owner, caregiver, fixture, nav, pass }) {
  await nav(caregiver.page, 'Today');
  await caregiver.page.getByRole('region', { name: 'Attention' }).waitFor();
  const grant = (await owner.dash()).access_grants.find(row => row.user?.id === fixture.caregiver_id);
  assert(grant);
  await owner.api('/app/grants/' + grant.id, undefined, 'DELETE');
  // The open dashboard polls access and can already be clearing itself here.
  await caregiver.page.getByLabel('Email address', { exact: true }).waitFor();
  assert.equal(await caregiver.page.getByRole('region', { name: 'Attention' }).count(), 0);
  assert.equal(await caregiver.page.getByText('My left knee felt sore after my walk.', { exact: true }).count(), 0);
  pass('Revoking caregiver access removes the visible Attention rows and care facts');
}

module.exports = { checkFirstUse, checkFirstUpdateSaved, checkAskParse, checkCaregiverRevocation };
