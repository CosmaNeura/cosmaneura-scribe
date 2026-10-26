// Run explicitly with SCRIBE_TEST_PLAYWRIGHT pointing at the already installed
// Playwright module. This local synthetic browser test never contacts Scribe.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { observeScrollDocument, validateScrollSnapshot, unchangedScrollFields } from './safe-scroll.mjs';
if (!process.env.SCRIBE_TEST_PLAYWRIGHT) throw Error('explicit_playwright_runtime_required');
const { chromium } = await import(process.env.SCRIBE_TEST_PLAYWRIGHT);
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;padding:0} main{padding:16px} section{padding:16px;border:1px solid}textarea{box-sizing:border-box;width:100%;height:700px}label{display:block}
</style><main><h1>Synthetic note</h1><section><label>Field one<textarea id="one" data-note-field="one"></textarea></label><label>Field two<textarea id="two" data-note-field="two"></textarea></label></section></main>`;
const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = { x: 0, y: 0, width: 402, height: 874 };
  await page.locator('#one').fill('synthetic '.repeat(200)); await page.locator('#two').fill('second field');
  await page.locator('h1').click();
  const before = validateScrollSnapshot(await page.evaluate(observeScrollDocument), frame);
  assert.deepEqual(before.margins, [8, 394]); assert.equal(before.fieldCount, 2);
  assert.equal(JSON.stringify(before).includes('synthetic'), false);
  await page.evaluate(() => { const area = document.querySelector('#one'); area.value = area.value.slice(0, 1500) + 'changed beyond AX limit'; });
  const after = validateScrollSnapshot(await page.evaluate(observeScrollDocument), frame);
  assert.throws(() => unchangedScrollFields(before, after), /document_changed/);
  await page.locator('#one').focus();
  const focused = await page.evaluate(observeScrollDocument);
  assert.throws(() => validateScrollSnapshot(focused, frame), /editor_focused/);
  await page.locator('h1').click();
  await page.evaluate(() => { const button = document.createElement('button'); button.id = 'left-blocker'; button.style = 'position:fixed;left:0;top:240px;width:20px;height:400px'; document.body.append(button); });
  const rightOnly = validateScrollSnapshot(await page.evaluate(observeScrollDocument), frame);
  assert.deepEqual(rightOnly.margins, [394]);
  await page.evaluate(() => { const button = document.createElement('button'); button.style = 'position:fixed;right:0;top:240px;width:20px;height:400px'; document.body.append(button); });
  const blocked = await page.evaluate(observeScrollDocument);
  assert.throws(() => validateScrollSnapshot(blocked, frame), /clear_margin_missing/);
  console.log(JSON.stringify({ status: 'PASS', cases: 5, executionKind: 'local-synthetic-browser', nativeTouch: 'NOT_RUN', rawFieldTextExported: false }));
} finally {
  if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
