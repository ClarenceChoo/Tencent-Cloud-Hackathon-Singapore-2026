/* Actual Chromium checks for the inert fictional UI preview. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const origin = process.env.PARSE_PREVIEW_ORIGIN || 'http://127.0.0.1:5194';
const output = path.resolve(process.env.PARSE_PREVIEW_DIR || path.join(root, 'runtime/ui-workflow-preview'));
const buildDir = path.resolve(process.env.PARSE_PREVIEW_BUILD_DIR || path.join(root, 'runtime/parse-workflow-preview-20261002'));
const url = new URL(origin);
assert(['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname), 'Preview origin must be loopback');
assert(output.startsWith(path.join(root, 'runtime') + path.sep), 'Evidence output must stay under ignored runtime');
assert(buildDir.startsWith(path.join(root, 'runtime') + path.sep), 'Served preview build must stay under ignored runtime');
fs.mkdirSync(output, { recursive: true });

const sources = [
  'frontend/src/uiPreview.ts', 'frontend/src/api.ts', 'frontend/src/App.tsx',
  'frontend/src/AskParse.tsx', 'frontend/src/CareVocabulary.tsx',
  'frontend/src/Companion.tsx', 'frontend/src/main.tsx', 'frontend/src/Landing.tsx',
  'frontend/src/SummaryPrint.tsx', 'frontend/src/styles.css', 'frontend/src/landing.css',
];
const digest = value => createHash('sha256').update(value).digest('hex');
function hashes(files) {
  const result = {};
  for (const file of files) {
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) result[file] = digest(fs.readFileSync(absolute));
  }
  return result;
}
function buildHashes() {
  if (!fs.existsSync(buildDir)) return {};
  const result = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[path.relative(root, file)] = digest(fs.readFileSync(file));
    }
  }
  visit(buildDir);
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const report = {
    at: new Date().toISOString(), origin: url.origin, browser: browser.version(),
    scope: 'Loopback-only Chromium preview workflow with fictional in-memory samples. No care API, microphone, persistence, or live sharing.',
    source_sha256: hashes(sources), served_preview_build_sha256: buildHashes(), checks: [], screenshots: [], pageErrors: [],
    v1Requests: [], getUserMediaCalls: 0, printCalls: 0, largeTextOverflows: [],
  };
  const save = () => fs.writeFileSync(path.join(output, 'browser-workflow-preview.json'), JSON.stringify(report, null, 2));
  const pass = name => { report.checks.push({ name, passed: true }); save(); console.log('PASS ' + name); };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.exposeBinding('__recordPreviewCall', (_source, kind) => {
    if (kind === 'microphone') report.getUserMediaCalls++;
    if (kind === 'print') report.printCalls++;
  });
  await context.addInitScript(() => {
    if (navigator.mediaDevices) {
      try { Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        void window.__recordPreviewCall('microphone');
        throw new Error('Microphone unavailable in the UI preview');
      }}); } catch { /* The test also listens for any browser media permission request. */ }
    }
    window.print = () => { void window.__recordPreviewCall('print'); };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('request', request => {
    let requestUrl;
    try { requestUrl = new URL(request.url()); } catch { return; }
    if (requestUrl.pathname.startsWith('/v1'))
      report.v1Requests.push({ method: request.method(), origin: requestUrl.origin, path: requestUrl.pathname });
  });
  page.on('request', request => {
    if (request.resourceType() === 'media') report.mediaRequests = (report.mediaRequests || 0) + 1;
  });
  const capture = async (view, width) => {
    await page.setViewportSize({ width, height: 980 });
    await page.waitForTimeout(120);
    const geometry = await page.evaluate(() => ({
      innerWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth,
    }));
    assert(geometry.documentWidth <= geometry.innerWidth + 1, `${view} horizontal overflow at ${width}px: ${JSON.stringify(geometry)}`);
    const filename = `${view}-${width}.png`;
    await page.screenshot({ path: path.join(output, filename), fullPage: true });
    report.screenshots.push(filename);
  };
  const appNav = page.getByRole('navigation', { name: 'Main navigation' });
  const navigate = async label => {
    if (await page.getByRole('button', { name: 'Open menu', exact: true }).isVisible().catch(() => false))
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await appNav.getByRole('button', { name: label, exact: true }).click();
  };
  const layouts = async view => { for (const width of [320, 390, 1440]) await capture(view, width); };

  try {
    await page.goto(`${url.origin}/landing/`);
    await page.getByRole('heading', { name: /care, connected/i }).waitFor().catch(async () => {
      await page.getByRole('link', { name: 'Open Parse', exact: true }).first().waitFor();
    });
    await page.getByRole('link', { name: 'Open Parse', exact: true }).first().click();
    await page.getByRole('heading', { name: /care timeline/i }).waitFor();
    assert(await page.getByText('UI demo · fictional sample data', { exact: true }).count());
    await navigate('Today');
    await page.getByRole('heading', { name: 'Attention', exact: true }).waitFor();
    await layouts('dashboard');
    pass('Landing Open Parse navigation opens the fictional dashboard');

    await navigate('Ask Parse');
    await page.locator('#ask-parse-title').waitFor();
    await page.getByRole('button', { name: 'Find answer', exact: true }).click();
    await page.getByText('Fictional example shown.', { exact: true }).waitFor();
    await layouts('ask-parse');
    await page.getByRole('button', { name: 'View source', exact: true }).click();
    await page.getByRole('heading', { name: 'Fictional source', exact: true }).waitFor();
    assert(await page.getByText(/122\/78 mmHg/).count());
    await layouts('ask-source');
    pass('Ask Parse answers from a fictional sample and its source control exposes only fictional source details');

    await navigate('Settings');
    await page.getByRole('heading', { name: 'Care preferences', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Reviewed care names' }).waitFor();
    assert(await page.getByText('Only an account with profile management permission can view or change these names.', { exact: true }).count());
    assert.equal(await page.getByRole('button', { name: 'Save reviewed names', exact: true }).count(), 0);
    await page.getByLabel('Preferred name', { exact: true }).fill('Maya preview');
    const preferenceSave = page.getByRole('button', { name: 'Save preferences', exact: true });
    assert(await preferenceSave.isEnabled(), 'Preview preference action should remain testable');
    await preferenceSave.click();
    await page.getByRole('alert').filter({ hasText: 'UI demo only: fictional sample data. This action is not saved or shared.' }).waitFor();
    await layouts('settings-vocabulary');
    pass('Settings blocks vocabulary and profile writes');

    await navigate('Visit summary');
    await page.getByRole('heading', { name: 'A summary you can review', exact: true }).waitFor();
    await page.getByText('Recent care', { exact: true }).waitFor();
    const printButton = page.getByRole('button', { name: 'Print / Save as PDF', exact: true });
    if (await printButton.count()) {
      await printButton.click();
      await page.getByRole('alert').filter({ hasText: /could not check access to this summary/i }).waitFor();
      assert.equal(report.printCalls, 0, 'Preview must not open the print dialog');
    }
    const purpose = page.getByLabel('Summary purpose');
    await purpose.selectOption('family_handoff');
    const questions = page.getByLabel('Questions to discuss');
    await questions.fill('Ask about the fictional sample visit.');
    const from = page.getByLabel('From', { exact: true }); const to = page.getByLabel('To', { exact: true });
    const fromValue = await from.inputValue(); const toValue = await to.inputValue();
    assert(fromValue && toValue && fromValue <= toValue, 'Summary date range must be valid');
    await page.getByRole('button', { name: /^Prepare( a fresh)? draft$/, exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'UI demo only: fictional sample data. This action is not saved or shared.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Share read-only', exact: true }).isDisabled(), true);
    await layouts('visit-summary');
    pass('Summary purpose and authored questions are editable; deliberate preparation shows the preview-only message and exposes no print/share action');

    await page.goto(`${url.origin}/shared/summaries/sample-preview-token`);
    await page.getByText('UI demo · fictional sample data', { exact: true }).waitFor();
    assert(await page.getByText(/Maya Tan \(sample\)/).count());
    assert(!(await page.locator('body').innerText()).includes('sample-preview-token'));
    await layouts('shared-summary-sample');
    pass('A shared-summary-shaped URL stays inside the sample dashboard and reveals no token-backed content');

    await page.goto(`${url.origin}/companion`);
    await page.getByRole('heading', { name: 'Companion preview', exact: true }).waitFor();
    assert(await page.getByText(/does not use the microphone, enroll a device, or contact a voice provider/i).count());
    await layouts('companion-preview');
    pass('Companion route presents the inert preview notice');

    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 980 });
      await page.evaluate(() => {
        const originals = [];
        const selector = 'h1,h2,h3,p,span,label,button,a,small,strong,summary,legend';
        for (const element of document.querySelectorAll(selector)) {
          if (!Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
          const size = parseFloat(getComputedStyle(element).fontSize);
          if (Number.isFinite(size)) {
            originals.push([element, element.style.getPropertyValue('font-size'), element.style.getPropertyPriority('font-size'), element.style.getPropertyValue('line-height'), element.style.getPropertyPriority('line-height')]);
            element.style.setProperty('font-size', `${size * 2}px`, 'important');
            element.style.setProperty('line-height', '1.4', 'important');
          }
        }
        window.__previewTextOriginals = originals;
      });
      const geometry = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
      if (geometry.document > geometry.viewport + 1) report.largeTextOverflows.push({ width, ...geometry });
      const filename = `companion-preview-text-200-${width}.png`;
      await page.screenshot({ path: path.join(output, filename), fullPage: true });
      report.screenshots.push(filename);
      await page.evaluate(() => {
        for (const [element, fontSize, fontPriority, lineHeight, linePriority] of window.__previewTextOriginals || []) {
          if (fontSize) element.style.setProperty('font-size', fontSize, fontPriority); else element.style.removeProperty('font-size');
          if (lineHeight) element.style.setProperty('line-height', lineHeight, linePriority); else element.style.removeProperty('line-height');
        }
        delete window.__previewTextOriginals;
      });
    }
    if (!report.largeTextOverflows.length) pass('Companion preview keeps its controls visible at 200% rendered text');
    else { report.checks.push({ name: 'Companion preview 200% text layout', passed: false, overflows: report.largeTextOverflows }); save(); console.error('FAIL Companion preview 200% text layout: ' + JSON.stringify(report.largeTextOverflows)); }

    const browserState = await page.evaluate(() => ({
      localStorage: Object.keys(localStorage), sessionStorage: Object.keys(sessionStorage),
      storageValues: [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'),
    }));
    report.storageKeys = { localStorage: browserState.localStorage, sessionStorage: browserState.sessionStorage };
    assert.equal(report.v1Requests.length, 0, 'No same-origin /v1 request is allowed');
    assert.equal(report.getUserMediaCalls, 0, 'Preview must not call getUserMedia');
    assert.equal((report.mediaRequests || 0), 0, 'Preview must not request media');
    assert.equal(report.printCalls, 0, 'Preview must not open the print dialog');
    assert(!/Maya Tan|Sample daily medicine|Fictional home monitor|sample-patient|sample-caregiver/i.test(browserState.storageValues), 'Care data must not enter browser storage');
    assert.deepEqual(report.pageErrors, [], 'Browser page errors occurred');
    pass('No /v1 requests, microphone use, printing, or care data in browser storage');
    assert.equal(report.largeTextOverflows.length, 0, `200% rendered text overflow: ${JSON.stringify(report.largeTextOverflows)}`);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    await page.screenshot({ path: path.join(output, 'browser-workflow-preview-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    save();
    await context.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
