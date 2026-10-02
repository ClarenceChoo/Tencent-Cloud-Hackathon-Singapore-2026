/* Optional F03 checks for tools/browser_web_companion.cjs.
 * Call after a support request is confirmed and before its recipient acknowledges it:
 *   await checkAssignedRequest({ owner, caregiver, supportId: support.id, pass });
 * Both login handles are the existing fictional local fixture handles; this file
 * performs no setup, provider access, or credential handling.
 */
const assert = require('node:assert/strict');

async function checkAssignedRequest({ owner, caregiver, supportId, pass }) {
  const navToday = page => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Today', exact: true }).click();
  await navToday(caregiver.page);
  const panel = caregiver.page.getByRole('region', { name: 'Attention' });
  const row = panel.locator('li.care-action-row', { hasText: 'Support request' });
  await row.waitFor();
  assert.equal(await panel.locator('li.care-action-row').count(), Number(await panel.locator('.care-action-count').textContent()));
  await row.getByRole('button', { name: /^Open request/ }).click();
  await caregiver.page.locator(`[data-action-source="support_request:${supportId}"]`).waitFor();
  assert.equal(await caregiver.page.evaluate(() => document.activeElement?.getAttribute('data-action-source')), `support_request:${supportId}`);
  let acknowledgements = 0;
  const acknowledgementRoute = `**/v1/app/support-requests/${supportId}/acknowledge`;
  await caregiver.page.route(acknowledgementRoute, async route => {
    acknowledgements++;
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.continue();
  });
  await caregiver.page.locator(`[data-action-source="support_request:${supportId}"]`).getByRole('button', { name: 'Acknowledge' })
    .evaluate(button => { button.click(); button.click(); });
  await caregiver.page.getByText('Request acknowledged.').waitFor();
  await caregiver.page.unroute(acknowledgementRoute);
  assert.equal(acknowledgements, 1, 'Repeated pending clicks sent duplicate acknowledgements');
  const refreshed = await caregiver.dash();
  assert.equal(refreshed.support_requests.find(item => item.id === supportId)?.status, 'acknowledged');
  await navToday(caregiver.page);
  assert.equal(await panel.locator('li.care-action-row').count(), Number(await panel.locator('.care-action-count').textContent()));
  const ownerData = await owner.dash();
  assert(ownerData.support_requests.some(item => item.id === supportId));
  pass('Attention routes an assigned request to its source; repeated pending clicks send one acknowledgement and refresh the panel');
}

async function checkInboxSourcesAndScope({ owner, caregiver, restricted, supportId, fixture, nav, pass }) {
  const create = async (kind, payload) => {
    const proposal = await owner.api('/app/patients/' + fixture.patient_id + '/proposals', { kind, payload });
    return owner.api('/app/proposals/' + proposal.id + '/confirm', { confirmed: true });
  };
  const followup = await create('followup', { related_type: 'support_request', related_id: supportId,
    check_at: new Date(Date.now() + 3600000).toISOString(), permission_scope: 'related_recipients', resolution_state: 'open' });
  const task = await create('preventive_task', { task_type: 'screening', description: 'Fictional care-plan check',
    source: 'Fictional care plan', due_date: '2026-10-03', timezone: 'Asia/Singapore', state: 'due' });
  await owner.page.getByRole('button', { name: 'Refresh care data' }).click();
  await nav(owner.page, 'Today');
  const attention = owner.page.getByRole('region', { name: 'Attention' });
  await attention.getByRole('button', { name: /^Record outcome Follow-up/ }).click();
  const followupRow = owner.page.locator(`[data-action-source="followup:${followup.record_id}"]`);
  await followupRow.waitFor();
  assert.equal(await owner.page.evaluate(() => document.activeElement?.getAttribute('data-action-source')), `followup:${followup.record_id}`);
  await followupRow.getByRole('button', { name: /Record follow-up outcome/ }).click();
  await followupRow.getByLabel('Reported follow-up outcome').fill('Fictional recipient reported the call completed.');
  await followupRow.getByRole('button', { name: 'Review outcome', exact: true }).click();
  const review = owner.page.getByRole('dialog', { name: 'Review before confirming' });
  await review.waitFor();
  assert.equal((await owner.dash()).followups.find(row => row.id === followup.record_id).resolution_state, 'open');
  await review.getByRole('button', { name: 'Confirm and save', exact: true }).click();
  await review.waitFor({ state: 'hidden' });
  assert.equal((await owner.dash()).followups.find(row => row.id === followup.record_id).resolution_state, 'resolved');
  await nav(owner.page, 'Today');
  assert.equal(await attention.getByRole('button', { name: /^Record outcome Follow-up/ }).count(), 0);
  await attention.getByRole('button', { name: 'Open Care-plan task: Fictional care-plan check' }).click();
  await owner.page.locator(`[data-action-source="preventive_task:${task.record_id}"]`).waitFor();
  assert.equal(await owner.page.evaluate(() => document.activeElement?.getAttribute('data-action-source')), `preventive_task:${task.record_id}`);
  await nav(owner.page, 'Today');
  await owner.page.getByLabel('Choose patient profile').selectOption(fixture.second_patient_id);
  await owner.page.getByText('Nothing needs attention in this care space right now.').waitFor();
  assert.equal(await owner.page.getByText('Fictional care-plan check', { exact: true }).count(), 0);
  await owner.page.getByLabel('Choose patient profile').selectOption(fixture.patient_id);
  await attention.getByText('Fictional care-plan check', { exact: true }).waitFor();
  assert.equal((await restricted.dash()).support_requests.length, 0);
  assert.equal((await restricted.dash()).followups.length, 0);
  pass('Attention focuses care-plan and follow-up sources, requires outcome review/confirmation, and clears rows across care-space switches');
}

module.exports = { checkAssignedRequest, checkInboxSourcesAndScope };
