/* Optional browser fixture step. Import recoverLostReceipt from the main browser runner. */
const assert = require('node:assert/strict');

async function recoverLostReceipt({ page, arm, caregiverDashboard, noteCount, caregiverName, transcript, interpretation }) {
  let uploads = 0;
  let confirmations = 0;
  let audioRequests = 0;
  const observe = request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/v1/web/turns') uploads++;
    if (request.method() === 'POST' && /\/v1\/web\/proposals\/[^/]+\/confirm$/.test(path)) confirmations++;
    if (/\/v1\/web\/audio\//.test(path)) audioRequests++;
  };
  page.on('request', observe);
  let accepted = false;
  await page.route('**/v1/web/turns', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 202, 'Fixture server must accept the turn before its reply is lost');
    accepted = true;
    await route.abort('failed');
  }, { times: 1 });
  try {
    arm('receipt-recovery', transcript, interpretation);
    await page.getByRole('button', { name: 'Tap to record', exact: true }).click();
    await page.getByRole('button', { name: 'Tap to send', exact: true }).waitFor();
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Tap to send', exact: true }).click();
    await page.getByRole('region', { name: 'Recording receipt' }).getByText('Receipt unknown').waitFor();
    assert(accepted); assert.equal(uploads, 1); assert.equal(confirmations, 0); assert.equal(audioRequests, 0);
    await page.reload();
    const card = page.getByRole('region', { name: 'Recording receipt' });
    await card.getByText('Receipt unknown').waitFor();
    await card.getByRole('button', { name: 'Check recording' }).focus();
    await page.keyboard.press('Enter');
    await card.getByText('Ready for your review').waitFor();
    assert.equal(uploads, 1); assert.equal(confirmations, 0); assert.equal(audioRequests, 0);
    assert.equal((await caregiverDashboard()).notes.length, noteCount);
    assert(await page.getByRole('region', { name: 'Review before saving' }).getByText(caregiverName).count());
    const stored = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
    assert(!stored.includes(transcript), 'Care text entered browser storage');
    return { uploads, confirmations, audioRequests };
  } finally {
    await page.unroute('**/v1/web/turns');
    page.off('request', observe);
  }
}

module.exports = { recoverLostReceipt };
