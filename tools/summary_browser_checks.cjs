/* Reviewed summary and print checks against the disposable fictional fixture. */
const assert = require('node:assert/strict');
const path = require('node:path');

async function checkPurposeSummaries({ owner, fixture, nav, pass, dir, origin }) {
  const page = owner.page;
  await nav(page, 'Visit summary');
  const purpose = page.getByLabel('Summary purpose', { exact: true });
  const questions = page.getByLabel('Questions to discuss', { exact: true });
  const oneQuestion = 'Could the team discuss this fictional concern, which has not been reported as a care event?';
  await questions.fill(oneQuestion);
  let sourceIds;
  let firstPublicPath;
  let weekly;
  for (const [value, label] of [['doctor_visit', 'Doctor visit'], ['family_handoff', 'Family handoff'], ['weekly_review', 'Weekly care review']]) {
    await purpose.selectOption(value);
    if (value !== 'doctor_visit') {
      assert(await page.getByRole('button', { name: 'Share read-only', exact: true }).isDisabled());
      assert.equal(await page.getByRole('button', { name: 'Print / Save as PDF', exact: true }).count(), 0);
    }
    if (value === 'weekly_review') {
      await questions.fill(Array.from({ length: 10 }, (_, i) => `Question ${i + 1}: ` + 'A fictional discussion point, not a reported event. '.repeat(9)).join('\n'));
    }
    const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/v1/app/patients/' + fixture.patient_id + '/summaries');
    await page.getByRole('button', { name: /^Prepare (a fresh )?draft$/ }).click();
    const created = await createdResponse;
    assert.equal(created.status(), 201);
    const draft = await created.json();
    assert.equal(draft.purpose, value); assert.equal(draft.template_version, 1); assert.equal(draft.status, 'draft');
    const ids = draft.sources.map(source => `${source.type}:${source.id}:${source.version}`).sort();
    if (!sourceIds) sourceIds = ids; else assert.deepEqual(ids, sourceIds);
    await page.locator('.summary-meta').getByText(label + ' · template 1', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Share read-only', exact: true }).isDisabled());
    const authored = draft.sections.find(section => section.kind === 'authored_questions');
    assert(authored && authored.items.length === (value === 'weekly_review' ? 10 : 1));
    assert(authored.items.every(item => !item.source_id && !item.author_id && item.author_display_name === 'Fictional Alex Tan'));
    if (firstPublicPath) assert.equal((await owner.context.request.get('/v1' + firstPublicPath)).status(), 200,
      'Preparing another purpose silently invalidated the previously reviewed version');
    const reviewedResponse = page.waitForResponse(response => response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/v1/app/summaries/' + draft.id);
    await page.getByRole('button', { name: 'Save review', exact: true }).focus();
    await page.keyboard.press('Enter');
    const reviewed = await reviewedResponse;
    assert.equal(reviewed.status(), 200);
    const row = await reviewed.json(); assert.equal(row.status, 'reviewed');
    await page.getByRole('button', { name: 'Print / Save as PDF', exact: true }).waitFor();
    if (value === 'doctor_visit') {
      await page.getByRole('button', { name: 'Share read-only', exact: true }).click();
      const publicLink = page.getByRole('link', { name: 'Open read-only view', exact: true });
      await publicLink.waitFor();
      firstPublicPath = new URL(await publicLink.getAttribute('href'), origin).pathname;
      assert(firstPublicPath.startsWith('/shared/summaries/'));
      const shared = await owner.context.request.get('/v1' + firstPublicPath);
      assert.equal(shared.status(), 200);
      const sharedData = await shared.json();
      assert.equal(sharedData.summary.purpose, 'doctor_visit');
      assert(!JSON.stringify(sharedData).includes('author_id'));
      assert(!JSON.stringify(sharedData).includes('@web.invalid'));
    }
    if (value === 'weekly_review') weekly = row;
  }
  pass('All three summary purposes preserve the same source identities, label authored questions, and require a new review; preparing another purpose preserves the earlier reviewed share');

  await page.setViewportSize({ width: 320, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Summary controls overflow at 320 pixels');
  await page.screenshot({ path: path.join(dir, 'web-summary-320.png'), fullPage: true });
  await page.evaluate(() => {
    window.__parseSummaryTextStyles = [];
    for (const element of document.querySelectorAll('body *')) {
      if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
      const style = getComputedStyle(element);
      window.__parseSummaryTextStyles.push([element, element.style.fontSize, element.style.lineHeight]);
      element.style.fontSize = (parseFloat(style.fontSize) * 2) + 'px'; element.style.lineHeight = '1.4';
    }
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Summary controls overflow at 200% text');
  await page.screenshot({ path: path.join(dir, 'web-summary-200-percent-text.png'), fullPage: true });
  await page.evaluate(() => {
    for (const [element, fontSize, lineHeight] of window.__parseSummaryTextStyles) { element.style.fontSize = fontSize; element.style.lineHeight = lineHeight; }
    delete window.__parseSummaryTextStyles;
  });
  pass('Summary statements, source references, purpose controls and questions fit at 320 pixels with normal and 200% text');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { window.__parsePrintCalls = 0; window.print = () => { window.__parsePrintCalls++; }; });
  const freshPrint = page.waitForResponse(response => response.request().method() === 'GET' &&
    new URL(response.url()).pathname === '/v1/app/summaries/' + weekly.id + '/print');
  await page.getByRole('button', { name: 'Print / Save as PDF', exact: true }).click();
  const checked = await freshPrint;
  assert.equal(checked.status(), 200); assert.match(checked.headers()['cache-control'], /no-store/);
  await page.waitForFunction(() => window.__parsePrintCalls === 1);
  const sheet = page.getByRole('article', { name: 'Reviewed care summary for print', includeHidden: true });
  await sheet.waitFor({ state: 'attached' });
  const text = await sheet.textContent();
  assert(text.includes('Weekly care review') && text.includes('Selected period') && text.includes('Generated') && text.includes('Source:'));
  assert(text.includes('Authored question') && text.includes('cannot be revoked'));
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: path.join(dir, 'web-summary-print.png'), fullPage: true });
  const pdf = await page.pdf({ path: path.join(dir, 'web-weekly-summary.pdf'), format: 'A4', printBackground: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  assert(pages > 1, 'Long questions did not produce the intended multi-page print check');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await sheet.waitFor({ state: 'detached' });
  pass(`Printing fetches the current authorized reviewed summary before the dialog; a ${pages}-page fictional PDF retains dates, source references, question authorship and copy-permanence labels`);

  const changed = oneQuestion + ' This is a changed question.';
  await questions.fill(changed);
  assert(await page.getByRole('button', { name: 'Share read-only', exact: true }).isDisabled());
  assert.equal(await page.getByRole('button', { name: 'Print / Save as PDF', exact: true }).count(), 0);
  const old = weekly.questions[0];
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.getByRole('button', { name: 'Print / Save as PDF', exact: true }).waitFor();
  const updated = (await owner.dash()).summaries.find(row => row.id === weekly.id);
  assert.equal(updated.questions[0].text, changed);
  assert.notEqual(updated.questions[0].authored_at, old.authored_at);

  // A real source mutation invalidates all dependent views and print preparation.
  const privateNote = (await owner.dash()).notes.find(row => row.wording === 'A private note: I slept poorly.');
  assert(privateNote);
  await owner.api('/app/notes/' + privateNote.id, undefined, 'DELETE');
  await page.getByRole('button', { name: 'Refresh care data', exact: true }).click();
  await page.getByRole('button', { name: 'Print / Save as PDF', exact: true }).waitFor({ state: 'hidden' });
  const shareAfterDeletion = page.getByRole('button', { name: 'Share read-only', exact: true });
  assert((await shareAfterDeletion.count()) === 0 || await shareAfterDeletion.isDisabled());
  assert.equal((await owner.context.request.get('/v1' + firstPublicPath)).status(), 410);
  const deniedPrint = await owner.context.request.get('/v1/app/summaries/' + weekly.id + '/print');
  assert.equal(deniedPrint.status(), 409); assert.match(deniedPrint.headers()['cache-control'], /no-store/);
  pass('Changed questions need a fresh review; deleting a source disables sharing/printing and invalidates the previous shared view');
}

module.exports = { checkPurposeSummaries };
