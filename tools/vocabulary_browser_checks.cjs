/* Reviewed vocabulary acceptance against fictional same-origin local data only. */
const assert = require('node:assert/strict');
const path = require('node:path');

async function checkReviewedVocabulary({ owner, restricted, fixture, nav, pass, dir }) {
  await nav(owner.page, 'Settings');
  const names = owner.page.getByRole('region', { name: 'Reviewed care names', exact: true });
  await names.getByText('Version 0 · No reviewed names yet', { exact: true }).waitFor();
  await names.getByRole('button', { name: 'Add Example medicine', exact: true }).click();
  await names.getByRole('button', { name: 'Add alternative', exact: true }).click();
  await names.getByLabel('Alternative 1', { exact: true }).fill('Example med');
  await names.getByRole('button', { name: 'Save reviewed names', exact: true }).focus();
  await owner.page.keyboard.press('Enter');
  await names.getByText('Reviewed names saved.', { exact: true }).waitFor();
  const route = '/app/patients/' + fixture.patient_id + '/vocabulary';
  const saved = await owner.api(route);
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.terms, [{ canonical: 'Example medicine', aliases: ['Example med'], category: 'medicine' }]);

  await names.getByRole('button', { name: 'Add alternative', exact: true }).click();
  await names.getByLabel('Alternative 2', { exact: true }).fill('Example dose');
  await owner.api(route, { expected_version: saved.version, terms: [...saved.terms,
    { canonical: 'Fictional clinic', aliases: [], category: 'other' }] }, 'PUT');
  await names.getByRole('button', { name: 'Save reviewed names', exact: true }).click();
  await names.getByRole('heading', { name: 'Current saved version 2', exact: true }).waitFor();
  assert.equal(await names.getByLabel('Alternative 2', { exact: true }).inputValue(), 'Example dose');
  assert.equal((await owner.api(route)).version, 2);
  const storage = await owner.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert(!/Example dose|Example med|Fictional clinic/.test(storage));
  await names.getByRole('button', { name: 'Use current saved version', exact: true }).click();
  await owner.page.setViewportSize({ width: 320, height: 900 });
  assert(await owner.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Vocabulary causes narrow-screen overflow');
  await owner.page.screenshot({ path: path.join(dir, 'web-vocabulary-320.png'), fullPage: true });
  await owner.page.setViewportSize({ width: 1440, height: 1000 });

  await owner.page.getByLabel('Choose patient profile', { exact: true }).selectOption(fixture.second_patient_id);
  await names.getByText('Version 0 · No reviewed names yet', { exact: true }).waitFor();
  assert.equal(await names.getByLabel('Checked name', { exact: true }).count(), 0);
  await owner.page.getByLabel('Choose patient profile', { exact: true }).selectOption(fixture.patient_id);
  await names.getByLabel('Checked name', { exact: true }).first().waitFor();
  assert.equal(await names.getByLabel('Checked name', { exact: true }).first().inputValue(), 'Example medicine');
  await nav(restricted.page, 'Settings');
  const restrictedNames = restricted.page.getByRole('region', { name: 'Reviewed care names', exact: true });
  await restrictedNames.getByText('Only an account with profile management permission can view or change these names.', { exact: true }).waitFor();
  assert.equal(await restrictedNames.getByLabel('Checked name', { exact: true }).count(), 0);
  pass('Reviewed care names need an explicit save, preserve unsaved entries on a version conflict, stay out of browser storage, and clear across care spaces and permissions');
}

module.exports = { checkReviewedVocabulary };
