/* global window */
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.SCRIBE_LAB_ROOT;
if (!root) throw new Error('SCRIBE_LAB_ROOT required');
if (process.argv[2] !== '--child') {
  // Clerk helpers can log credential-bearing URLs on failures. Capture/discard all
  // child output, including asynchronous cleanup warnings; emit only our receipt.
  await rm(resolve(root, 'browser-auth.json'), { force: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'],
    { env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume(); // Drain without retaining secrets.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Chromium may have its own process group: identify only this child's tree.
    let rows = [];
    try { rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 })
      .trim().split('\n').map(r => r.trim().split(/\s+/).map(Number)); } catch { /* Kill owned group below. */ }
    const owned = new Set([child.pid]);
    for (let n = -1; n !== owned.size;) { n = owned.size;
      for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid); }
    for (const pid of [...owned].reverse()) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }, 150000);
  const status = await new Promise(r => { child.on('error', () => r(null)); child.on('close', r); });
  clearTimeout(timer);
  if (!timedOut && status !== null) {
    try { const report = JSON.parse(await readFile(resolve(root, 'browser-auth.json'), 'utf8'));
      if (status !== 0) report.passed = false;
      console.log(JSON.stringify(report)); }
    catch { console.log('{"passed":false,"failed_step":"runner"}'); }
  } else console.log('{"passed":false,"failed_step":"runner_timeout"}');
  process.exit(!timedOut && status === 0 ? 0 : 1);
}
const dependency = path => pathToFileURL(resolve(root, 'runtime/node_modules', path)).href;
const { chromium } = await import(dependency('playwright/index.mjs'));
const { clerk } = await import(dependency('@clerk/testing/dist/playwright/index.mjs'));
const result = { scope: 'live staging Clerk browser SDK; not native hosted-login or Core membership proof',
  passed: false, cases: [], api_failures: [] };
const browser = await chromium.launch({ headless: true });
const identities = [];
let step = 'load';
try {
  for (const suffix of ['a', 'b']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    step = `load_${suffix}`;
    page.on('response', async response => {
      if (new URL(response.url()).hostname !== 'resolved-emu-53.clerk.accounts.dev' || response.status() < 400) return;
      try {
        const data = await response.json();
        const codes = (data.errors ?? []).map(e => e.code).filter(c => /^[a-z_]{1,80}$/.test(c));
        result.api_failures.push({ case: suffix, status: response.status(), codes });
      } catch { /* Content is never logged. */ }
    });
    let ownedSession = false;
    try {
      await page.goto('https://staging-app.cosmaneura.com/sign-in', { waitUntil: 'domcontentloaded' });
      await clerk.loaded({ page });
      await page.locator('input[name="identifier"]').waitFor({ state: 'visible' });
      step = `email_code_${suffix}`;
      await clerk.signIn({ page,
        signInParams: { strategy: 'email_code', identifier: `scribe-lab-${suffix}+clerk_test@example.com` },
        setupClerkTestingTokenOptions: { frontendApiUrl: 'resolved-emu-53.clerk.accounts.dev' } });
      ownedSession = true;
      step = 'fresh_token';
      const before = await page.evaluate(async () => ({ id: window.Clerk.user?.id,
        tokenPresent: Boolean(await window.Clerk.session?.getToken({ skipCache: true })) }));
      if (!before.id || !before.tokenPresent) throw new Error('session_unavailable');
      step = 'reload';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await clerk.loaded({ page });
      const persisted = await page.evaluate(() => window.Clerk.user?.id);
      if (persisted !== before.id) throw new Error('identity_changed');
      identities.push(before.id);
      result.cases.push({ case: suffix, fresh_token: true, reload_retained_identity: true,
        identity_sha256: createHash('sha256').update(before.id).digest('hex') });
    } finally {
      // Close only the session created in this disposable browser context.
      try { if (ownedSession) await clerk.signOut({ page }); }
      finally { await context.close(); }
    }
  }
  if (identities[0] === identities[1]) throw new Error('identities_not_isolated');
  result.passed = true;
} catch (error) {
  result.failed_step = step; // Never emit SDK errors, page content, cookies, or credentials.
  const message = String(error?.message ?? '');
  result.failure_kind = ['Execution context was destroyed', 'Target page', 'Timeout',
    'email_code is not enabled', 'already signed in', 'Failed to fetch', 'NetworkError', 'captcha']
    .find(code => message.includes(code)) ?? 'unclassified';
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(root, 'browser-auth.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
