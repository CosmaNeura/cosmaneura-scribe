import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, sha256 } from './journal.mjs';
import { matchingParticipantProcesses } from '../zoom/resource-owner.mjs';
import { code, projectAuthorization, projectSchedule, typeId, validAuthorizationWindow } from './zoom-bot-evidence.mjs';

const exec = promisify(execFile);
export const ZOOM_DASHBOARD = 'https://staging-app.cosmaneura.com';
const VIEW_AS = '/internal/v1/view-as/status';
async function boundedJSON(response) {
  let timer;
  try { return await Promise.race([response.json(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('zoom_response_body_timeout')), 5000); })]); }
  finally { clearTimeout(timer); }
}

/** Normal UI requests only. Authorize one exact POST once; never grant a
 * general API capability, issue a fetch, or substitute a filtered response. */
export function requestPolicy(url, method, body, { config, action, listsAllowed, postUsed, authorizationWindow, now = Date.now() }) {
  const parsed = new URL(url), path = parsed.pathname, authorization = config.authorization;
  if (!path.startsWith('/internal/') && !path.startsWith('/external/')) {
    if (parsed.origin === ZOOM_DASHBOARD && /^\/(notes|patients|schedule)(\/|$)/.test(path))
      return action === 'authorize' && path === `/schedule/${authorization?.meetingId}`;
    return true;
  }
  if (parsed.origin !== config.apiOrigin) return false;
  if (path.startsWith('/external/')) return action === 'connect'
    && method === 'GET' && ['/external/v1/zoom-oauth-start', '/external/v1/zoom-oauth-callback'].includes(path);
  if (method === 'GET') return ['/internal/v1/settings', '/internal/v1/practice', '/internal/v1/practice/organization-access', VIEW_AS].includes(path)
    || action === 'connect' && path === '/internal/v1/zoom-auth-url'
    || action === 'authorize' && (path === '/internal/v1/schedule'
      || listsAllowed && ['/internal/v1/notes', '/internal/v1/patients'].includes(path));
  if (method !== 'POST' || action !== 'authorize' || !listsAllowed || postUsed
    || path !== `/internal/v1/schedule/${authorization?.meetingId}/authorize-capture`
    || !validAuthorizationWindow(authorizationWindow, config, now)) return false;
  try { const value = JSON.parse(body); return Object.keys(value).length === 1 && value.appointment_id === authorization.appointmentRef; }
  catch { return false; }
}

/** An older asynchronous reply may never repopulate invalidated identity. */
export class LatestReply {
  sequence = 0; value = null;
  begin() { this.value = null; return ++this.sequence; }
  finish(sequence, value) { if (sequence === this.sequence) this.value = value; }
}

/** A response event can precede its body and a newer request can supersede it.
 * Wait for the current generation; an older completed body never fills the gap. */
export async function waitForLatestZoomReply(reader, { signal, timeoutMs }) {
  if (!(signal instanceof AbortSignal) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('zoom_response_wait_invalid');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw Error('zoom_latest_response_not_settled');
    if (reader.value !== null) return reader.value;
    await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
}

export function normalHostedScope(settings, viewAs, doctorRef, now = Date.now()) {
  const view = viewAs?.actor;
  if (settings?.doctorRef !== doctorRef || settings.failureCode || viewAs?.failureCode
    || !Number.isFinite(settings.observedAtEpochMs) || !Number.isFinite(viewAs?.observedAtEpochMs)
    || settings.observedAtEpochMs > now + 50 || viewAs.observedAtEpochMs > now + 50
    || now - settings.observedAtEpochMs > 15000 || now - viewAs.observedAtEpochMs > 15000
    || view?.active !== false || view.targetPresent !== false || view.readOnly !== false || view.requestBinding !== 'inactive'
    || !(view.canViewAs === false && view.doctorRef === null || view.canViewAs === true && view.doctorRef === doctorRef))
    throw Error('zoom_hosted_actor_mismatch');
  return { active: false, targetPresent: false, doctorRef: settings.doctorRef, doctorSource: 'normal-settings-response',
    canViewAs: view.canViewAs, viewAsActorPresent: view.doctorRef !== null, readOnly: false, requestBinding: 'inactive' };
}

export function currentMutationPermit(permit, { settings, viewAs, navigationSequence, config, now = Date.now() }) {
  if (!permit || !Number.isFinite(now) || permit.navigationSequence !== navigationSequence
    || permit.responseSequences?.settings !== settings.sequence || permit.responseSequences?.viewAs !== viewAs.sequence
    || permit.identitySHA256 !== config.identitySHA256 || !Number.isFinite(permit.observedAtEpochMs)
    || permit.observedAtEpochMs > now + 50 || now - permit.observedAtEpochMs > 15000) return false;
  try { normalHostedScope(settings.value, viewAs.value, config.doctorRef, now); return true; }
  catch { return false; }
}

export async function readZoomIdentity({ page, settings, viewAs, work, config, signal, clock = Date.now }) {
  signal.throwIfAborted();
  await page.waitForFunction(() => Boolean(window.Clerk?.loaded && window.Clerk?.user?.id && window.Clerk?.session?.id));
  const deadline = clock() + config.uiTimeoutMs;
  while (clock() <= deadline) {
    signal.throwIfAborted(); await Promise.allSettled([...work]);
    if (settings.value && viewAs.value) {
      const generation = [settings.sequence, viewAs.sequence];
      // The public Clerk state is read after current response settlement.
      const value = await page.evaluate(() => ({ user: window.Clerk?.user?.id, session: window.Clerk?.session?.id }));
      signal.throwIfAborted();
      if (settings.sequence !== generation[0] || viewAs.sequence !== generation[1]) continue;
      const actor = normalHostedScope(settings.value, viewAs.value, config.doctorRef, clock());
      if (typeof value.user !== 'string' || typeof value.session !== 'string' || !value.session
        || sha256(value.user) !== config.identitySHA256) throw Error('zoom_hosted_actor_mismatch');
      return { identitySHA256: sha256(value.user), sessionSHA256: sha256(value.session), actor, observedAtEpochMs: clock(),
        responseSequences: { settings: generation[0], viewAs: generation[1] } };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw Error('zoom_identity_response_not_settled');
}

export async function inspectZoomBrowsers(output, runIdentity, signal) {
  signal.throwIfAborted();
  const names = (await readdir(output)).filter(name => /^browser-owner-[a-f0-9-]{36}\.json$/.test(name));
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='], { signal, timeout: 5000, maxBuffer: 8000000 });
  const observations = [];
  for (const name of names) {
    const path = resolve(output, name), stat = await lstat(path), bytes = await readFile(path), owner = JSON.parse(bytes);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || owner.host !== hostname()
      || JSON.stringify(owner.runIdentity) !== JSON.stringify(runIdentity) || !owner.browser?.pid || !owner.browser?.profile)
      throw Error('zoom_browser_ownership_unconfirmed');
    const matches = matchingParticipantProcesses(stdout, owner);
    observations.push({ ownerSHA256: sha256(bytes), resourceId: owner.resourceId, matchingProcesses: matches });
    if (matches.length) throw Error('zoom_owned_browser_still_present');
  }
  return { source: 'current-owned-browser-process-inventory', observedAtEpochMs: Date.now(), observations };
}

/** Each call owns a fresh browser. A bounded OAuth wait permits the user to
 * authenticate normally; credentials and OAuth URLs never enter receipts. */
export async function openZoomUI({ config, output, runIdentity, signal }) {
  signal.throwIfAborted();
  let server, browser, page, closePromise, owner;
  const resourceId = randomUUID(), marker = `--scribe-virtual-lab-owner=${resourceId}`;
  const ownerPath = resolve(output, `browser-owner-${resourceId}.json`), work = new Set();
  let action = 'profile', listsAllowed = false, postUsed = false, authPermit = null, authorizationWindow = null, navigationSequence = 0;
  const settings = new LatestReply(), viewAs = new LatestReply(), schedule = new LatestReply(), authorization = new LatestReply();
  const sequences = new WeakMap(), responses = [], blocked = [];
  const onAbort = () => { void close().catch(() => {}); };
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (server) await server.close();
      await Promise.allSettled([...work]);
      if (!owner?.browser) throw Error('zoom_browser_launch_settlement_unknown');
      await inspectZoomBrowsers(output, runIdentity, new AbortController().signal);
      owner.phase = 'closed'; owner.closedAtEpochMs = Date.now(); await atomicJSON(ownerPath, owner);
      signal.removeEventListener('abort', onAbort);
      return { ownedResourcesSettled: true, source: 'current-owned-browser-process-inventory' };
    })();
    closePromise.catch(() => { closePromise = null; }); return closePromise;
  }
  try {
    const bytes = await readFile(config.storageState);
    if (sha256(bytes) !== config.storageStateSHA256) throw Error('hosted_session_store_changed');
    const { chromium } = await import(pathToFileURL(resolve(config.playwrightPath)).href);
    owner = { schema: 1, resourceId, host: hostname(), runIdentity, phase: 'launching', createdAtEpochMs: Date.now() };
    await atomicJSON(ownerPath, owner);
    // This request is awaited even after abort so a late launch handle is owned.
    server = await chromium.launchServer({ headless: config.action !== 'connect', args: [marker], timeout: 30000 });
    const child = server.process(), profileArgument = child.spawnargs.find(arg => arg.startsWith('--user-data-dir='));
    if (!profileArgument || !child.spawnargs.includes(marker) || !child.pid) throw Error('zoom_browser_process_identity_missing');
    owner.browser = { pid: child.pid, executable: await realpath(child.spawnfile), profile: await realpath(profileArgument.slice(16)) };
    owner.phase = 'active'; await atomicJSON(ownerPath, owner);
    signal.addEventListener('abort', onAbort, { once: true }); signal.throwIfAborted();
    browser = await chromium.connect(server.wsEndpoint()); signal.throwIfAborted();
    const context = await browser.newContext({ storageState: JSON.parse(bytes), serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(config.uiTimeoutMs);
    await context.route('**/*', async route => {
      const request = route.request(), method = request.method(), path = new URL(request.url()).pathname;
      const allowed = requestPolicy(request.url(), method, request.postData(), { config, action, listsAllowed, postUsed, authorizationWindow });
      if (!allowed || method === 'POST' && path.includes('/authorize-capture')
        && !currentMutationPermit(authPermit, { settings, viewAs, navigationSequence, config })) {
        if (blocked.length < 100) blocked.push({ method, path, action: 'blocked' });
        await route.abort('blockedbyclient'); return;
      }
      if (method === 'POST' && path.includes('/authorize-capture')) postUsed = true;
      await route.continue();
    });
    const targetFor = request => {
      const parsed = new URL(request.url());
      if (parsed.origin !== config.apiOrigin) return null;
      if (parsed.pathname === VIEW_AS) return viewAs;
      if (parsed.pathname === '/internal/v1/settings') return settings;
      if (parsed.pathname === '/internal/v1/schedule') return schedule;
      if (config.authorization && parsed.pathname === `/internal/v1/schedule/${config.authorization.meetingId}/authorize-capture`) return authorization;
      return null;
    };
    const navigationChanged = () => { navigationSequence++; authPermit = null; settings.begin(); viewAs.begin(); };
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigationChanged();
      const target = targetFor(request);
      if (target === settings || target === viewAs) authPermit = null;
      if (target) sequences.set(request, { target, sequence: target.begin() });
    });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) navigationChanged();
    });
    page.on('response', response => {
      const request = response.request(), item = sequences.get(request); if (!item) return;
      const pending = (async () => {
        const observed = { source: 'normal-hosted-ui-response', status: response.status(), observedAtEpochMs: Date.now() };
        try {
          if (!response.ok()) throw Error('zoom_normal_response_failed');
          const data = await boundedJSON(response);
          if (item.target === settings) {
            if (typeof data.zoom_connected !== 'boolean' || !typeId(data.doctor_id, 'doctor') || !Array.isArray(data.notes_schema)
              || data.notes_schema.some(row => !typeId(row.id, 'doctor_note_schema'))) throw Error('zoom_settings_invalid');
            observed.doctorRef = data.doctor_id;
            observed.connected = data.zoom_connected;
            observed.noteSchemaIds = data.notes_schema.map(row => row.id); observed.noteSchemaCount = data.notes_schema.length;
          }
          if (item.target === viewAs) observed.actor = { active: data.active, doctorRef: data.actor === null ? null : data.actor?.doctor_id,
            targetPresent: data.target !== null, canViewAs: data.can_view_as, readOnly: data.read_only, requestBinding: data.request_binding };
          if (item.target === schedule) observed.meeting = projectSchedule(data, config.authorization);
          if (item.target === authorization) observed.authorization = projectAuthorization(data, config.authorization);
        } catch (error) { observed.failureCode = code(error); }
        item.target.finish(item.sequence, observed);
        if (responses.length < 100) responses.push(observed);
      })();
      work.add(pending); pending.finally(() => work.delete(pending));
    });
    async function identity() {
      authPermit = null;
      const observedNavigation = navigationSequence;
      const value = await readZoomIdentity({ page, settings, viewAs, work, config, signal });
      const permit = { ...value, navigationSequence: observedNavigation };
      if (!currentMutationPermit(permit, { settings, viewAs, navigationSequence, config })) throw Error('zoom_hosted_actor_mismatch');
      if (responses.length < 100) responses.push({ source: 'normal-hosted-clerk-state', identitySHA256: value.identitySHA256,
        sessionSHA256: value.sessionSHA256, observedAtEpochMs: value.observedAtEpochMs });
      authPermit = permit; return value;
    }
    async function profile() {
      action = 'profile'; authPermit = null;
      settings.begin(); viewAs.begin();
      const waiter = page.waitForResponse(response => response.url() === `${config.apiOrigin}/internal/v1/settings`);
      void waiter.catch(() => {});
      await page.goto(`${ZOOM_DASHBOARD}/settings`, { waitUntil: 'domcontentloaded' }); await waiter;
      const account = await identity(), section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Zoom Integration', exact: true }) });
      await section.waitFor({ state: 'visible' }); await Promise.allSettled([...work]);
      const connectCount = await section.getByRole('button', { name: 'Connect Zoom', exact: true }).count();
      const connectedCount = await section.getByText('Connected', { exact: true }).count();
      if (settings.value?.failureCode || settings.value?.connected !== (connectedCount === 1)
        || settings.value.connected === false && connectCount !== 1) throw Error('zoom_profile_not_available');
      const path = resolve(output, `zoom-profile-${randomUUID()}.png`); await section.screenshot({ path }); await chmod(path, 0o600);
      return { source: 'normal-hosted-zoom-profile', executionKind: 'live', ...account, settings: settings.value,
        visible: { connectCount, connectedCount }, screenshot: { file: path.split('/').at(-1), sha256: sha256(await readFile(path)) } };
    }
    return {
      executionKind: 'live', profile, close,
      async connect() {
        action = 'connect'; await identity();
        await page.getByRole('button', { name: 'Connect Zoom', exact: true }).click();
        try {
          await page.waitForURL(url => url.origin === ZOOM_DASHBOARD && url.pathname === '/settings', { timeout: config.oauthTimeoutMs, waitUntil: 'domcontentloaded' });
          if (!settings.value?.connected) await page.getByText('Connected', { exact: true }).waitFor({ timeout: config.oauthTimeoutMs });
        } catch { signal.throwIfAborted(); return { status: 'OAUTH_INCOMPLETE', reason: 'normal_reviewer_authentication_required', observedAtEpochMs: Date.now() }; }
        return { status: 'OAUTH_RETURNED', observedAtEpochMs: Date.now() };
      },
      async schedule({ allowLists = false } = {}) {
        await profile();
        action = 'authorize'; listsAllowed = allowLists; authPermit = null;
        const waiter = page.waitForResponse(response => response.url() === `${config.apiOrigin}/internal/v1/schedule`); void waiter.catch(() => {});
        await page.goto(`${ZOOM_DASHBOARD}/schedule/${config.authorization.meetingId}`, { waitUntil: 'domcontentloaded' }); await waiter;
        const account = await identity(); await Promise.allSettled([...work]);
        const current = await waitForLatestZoomReply(schedule, { signal, timeoutMs: config.uiTimeoutMs });
        if (!current?.meeting) throw Error(current?.failureCode ?? 'zoom_schedule_not_observed');
        return { ...current, ...account };
      },
      async authorize({ hostWindow } = {}) {
        if (!listsAllowed || postUsed) throw Error('zoom_authorization_not_armed');
        const requireHostWindow = () => { if (!validAuthorizationWindow(authorizationWindow, config)) throw Error('zoom_authorization_host_window_expired'); };
        authorizationWindow = hostWindow ? Object.freeze({ ...hostWindow }) : null;
        requireHostWindow();
        await identity();
        await page.getByRole('button', { name: 'Enable meeting bot', exact: true }).click();
        await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Select the appointment', exact: true }) }).waitFor();
        await page.locator('#capture-appointment').selectOption(config.authorization.appointmentRef);
        await identity();
        requireHostWindow();
        await page.getByRole('button', { name: 'Confirm and enable', exact: true }).click();
        await page.getByText('Cosmas meeting bot enabled', { exact: true }).first().waitFor();
        await Promise.allSettled([...work]);
        if (!authorization.value?.authorization) throw Error(authorization.value?.failureCode ?? 'zoom_authorization_reply_missing');
        return authorization.value;
      },
      async observations() { await Promise.allSettled([...work]); return { responses, blocked }; },
    };
  } catch (error) {
    const cleanup = await close().catch(() => ({ ownedResourcesSettled: false }));
    throw Object.assign(Error(code(error)), { cleanup });
  }
}
