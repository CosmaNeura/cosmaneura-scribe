/* global window */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJSON, sha256 } from './journal.mjs';

const ORIGIN = 'https://staging-app.cosmaneura.com';
const EMAILS = Object.freeze(['scribe-lab-a+clerk_test@example.com', 'scribe-lab-b+clerk_test@example.com',
  'scribe-lab-a+clerk_test@cosmaneura.com', 'scribe-lab-b+clerk_test@cosmaneura.com']);

/** Normal hosted UI only. No Clerk testing helper, ticket or token injection. */
export async function hostedSignIn(page, email) {
  if (!EMAILS.includes(email)) throw Error('unapproved_synthetic_identity');
  await page.goto(`${ORIGIN}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="identifier"]').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Use another method', { exact: true }).click();
  const prepared = page.waitForResponse(response => new URL(response.url()).hostname === 'resolved-emu-53.clerk.accounts.dev'
    && new URL(response.url()).pathname.endsWith('/prepare_first_factor'), { timeout: 15000 });
  await page.getByRole('button', { name: `Email code to ${email}`, exact: true }).click();
  const prepareResponse = await prepared;
  if (!prepareResponse.ok()) {
    const codes = ((await prepareResponse.json()).errors ?? []).map(e => e.code);
    const code = codes.find(c => /^[a-z_]{1,50}$/.test(c));
    throw Error(code ? `code_preparation_${code}` : 'code_preparation_failed');
  }
  // This code is Clerk's documented reserved test-email OTP, not a user secret.
  const otp = page.locator('input[autocomplete="one-time-code"]');
  await otp.waitFor({ state: 'visible' });
  await otp.fill('424242');
  await page.waitForFunction(() => Boolean(window.Clerk?.user?.id), { timeout: 30000 });
  return page.evaluate(() => ({ userId: window.Clerk.user.id, sessionId: window.Clerk.session?.id }));
}

export async function probeNormalAccounts({ root, output, domain = 'example.com' }) {
  if (!['example.com', 'cosmaneura.com'].includes(domain)) throw Error('unapproved_synthetic_domain');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const { chromium } = await import(pathToFileURL(resolve(root, 'runtime/node_modules/playwright/index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  const result = { schema: 1, executionKind: 'live', scope: 'normal-hosted-browser-login-live-Clerk-Core-access',
    nativeRebuiltLogin: 'NOT_RUN', at: new Date().toISOString(), accounts: [], distinctIdentities: 'NOT_RUN',
    crossAccountAuthorityIsolation: 'NOT_RUN' };
  const identities = [];
  try {
    for (const [index, email] of EMAILS.filter(email => email.endsWith(`@${domain}`)).entries()) {
      const context = await browser.newContext();
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const account = { persona: `clinician-${index + 1}`, login: 'NOT_RUN', membership: 'NOT_RUN', signOut: 'NOT_RUN', revokedSessionReload: 'NOT_RUN' };
      let step = 'hosted_sign_in';
      try {
        const signed = await hostedSignIn(page, email);
        if (!signed.userId || !signed.sessionId) throw Error('session_missing');
        identities.push(signed.userId);
        account.identitySHA256 = sha256(signed.userId); account.login = 'PASS';
        step = 'core_access';
        await page.waitForURL(url => url.origin === ORIGIN && !url.pathname.startsWith('/sign-in'), { timeout: 30000 });
        // Read-only identity verification after UI sign-in; it does not mint tokens.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Clerk?.user?.id), { timeout: 30000 });
        await page.getByText('Loading application...', { exact: true }).waitFor({ state: 'hidden', timeout: 60000 });
        await page.getByRole('heading').first().waitFor({ state: 'visible', timeout: 30000 });
        account.reloadIdentityRetained = await page.evaluate(id => window.Clerk.user.id === id, signed.userId);
        const path = new URL(page.url()).pathname;
        account.route = /^\/(onboarding|notes|dashboard|appointments|scribe|sign-in)(\/|$)/.test(path) ? path.split('/').slice(0, 2).join('/') : '/other';
        // Persist only private synthetic UI evidence; no body text in process logs.
        await page.screenshot({ path: resolve(output, `${account.persona}.png`), fullPage: true });
        const body = await page.locator('body').innerText();
        await writeFile(resolve(output, `${account.persona}.txt`), body, { mode: 0o600 });
        account.membership = path.startsWith('/onboarding') ? 'BLOCKED' : 'NOT_RUN';
        account.legalGateVisible = /business associate agreement|accept.*baa|review.*baa/i.test(body);
        account.onboardingVisible = path.startsWith('/onboarding');
        // Separate session stores, authorized by the lab instructions, private on disk.
        const storage = await context.storageState();
        await atomicJSON(resolve(output, `${account.persona}.storage.json`), storage);
        step = 'sign_out';
        // Use the observed hosted Clerk menu. Closing a context is not sign-out.
        await page.getByRole('button', { name: 'Open user menu', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
        await page.waitForFunction(() => window.Clerk?.loaded && !window.Clerk.session, { timeout: 30000 });
        account.signOut = 'PASS';
        const revoked = await browser.newContext({ storageState: storage });
        try {
          const old = await revoked.newPage();
          await old.goto(`${ORIGIN}/notes`, { waitUntil: 'domcontentloaded' });
          await old.waitForFunction(() => window.Clerk?.loaded && !window.Clerk.session, { timeout: 30000 });
          await old.waitForURL(url => url.origin === ORIGIN && url.pathname.startsWith('/sign-in'), { timeout: 30000 });
          account.revokedSessionReload = 'PASS';
          await old.screenshot({ path: resolve(output, `${account.persona}-revoked.png`) });
        } finally { await revoked.close(); }
      } catch (error) {
        account.failedStep = step;
        account.failure = /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'ui_or_network_failure';
        if (account.login !== 'PASS') account.login = 'FAIL';
        await page.screenshot({ path: resolve(output, `${account.persona}-failure.png`) }).catch(() => {});
        await writeFile(resolve(output, `${account.persona}-failure.txt`), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 });
      } finally { await context.close(); result.accounts.push(account); await atomicJSON(resolve(output, 'result.json'), result); }
    }
    result.distinctIdentities = identities.length === 2 && new Set(identities).size === 2 ? 'PASS' : 'FAIL';
  } finally { await browser.close(); await atomicJSON(resolve(output, 'result.json'), result); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.env.SCRIBE_LAB_ROOT;
  if (!root || !process.argv[2]) throw Error('lab_root_and_output_required');
  try { const result = await probeNormalAccounts({ root, output: resolve(process.argv[2]), domain: process.argv[3] });
    console.log(JSON.stringify(result));
    process.exitCode = result.accounts.every(a => a.login === 'PASS') ? 0 : 2;
  } catch { console.log(JSON.stringify({ status: 'FAIL', code: 'normal_auth_runner_failed' })); process.exitCode = 2; }
}
