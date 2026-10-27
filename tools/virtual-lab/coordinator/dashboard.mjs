/* global window -- Playwright page callbacks execute in the browser. */
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJSON, sha256 } from './journal.mjs';
import { validateSaveCompletion } from './save-completion.mjs';
import { validateDesktopSaveCompletion } from './desktop-save-completion.mjs';

export const DASHBOARD_ORIGIN = 'https://staging-app.cosmaneura.com';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ref = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).test(value);
const failure = error => /^[a-z_]{1,100}$/.test(error?.message) ? error.message : 'dashboard_ui_unavailable';

/** Ordinary providers have actor:null when they have no support-view
 * capability. Their doctor identity comes from the normal Settings response. */
export function assertDashboardAccountScope({ settings, viewAs, identitySHA256, hostedSessionSHA256,
  expectedIdentitySHA256, expectedDoctorRef, now = Date.now() }) {
  const fresh = value => value?.status === 200 && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && Number.isFinite(value.observedAtEpochMs) && value.observedAtEpochMs <= now + 50
    && now - value.observedAtEpochMs <= 15000;
  if (!digest(identitySHA256) || identitySHA256 !== expectedIdentitySHA256 || !digest(hostedSessionSHA256)
    || !fresh(settings) || settings.source !== 'normal-hosted-settings-response' || !ref(settings.doctorRef, 'doctor')
    || expectedDoctorRef !== undefined && settings.doctorRef !== expectedDoctorRef
    || !fresh(viewAs) || viewAs.source !== 'normal-hosted-view-as-response'
    || viewAs.active !== false || viewAs.targetPresent !== false || viewAs.readOnly !== false || viewAs.requestBinding !== 'inactive'
    || !(viewAs.canViewAs === false && viewAs.actorDoctorRef === null
      || viewAs.canViewAs === true && viewAs.actorDoctorRef === settings.doctorRef)) throw Error('dashboard_actor_scope_mismatch');
  return { source: 'normal-hosted-account-observation', identitySHA256, hostedSessionSHA256,
    doctorRef: settings.doctorRef, settings, viewAs, observedAtEpochMs: now };
}

/** Passive projection of page-initiated replies. New requests invalidate old
 * values immediately, even if their older bodies have not finished parsing. */
export function observeDashboardAccount(page, apiOrigin) {
  const cells = { settings: { sequence: 0, value: null }, viewAs: { sequence: 0, value: null } };
  const requests = new WeakMap(), pending = new Set(); let disposed = false;
  const keyFor = request => request.method() !== 'GET' ? null
    : request.url() === `${apiOrigin}/internal/v1/settings` ? 'settings'
    : request.url() === `${apiOrigin}/internal/v1/view-as/status` ? 'viewAs' : null;
  const request = item => {
    const key = keyFor(item); if (!key || disposed) return;
    const cell = cells[key]; cell.value = null; requests.set(item, { key, sequence: ++cell.sequence });
  };
  const response = item => {
    const tracked = requests.get(item.request()); if (!tracked || disposed) return;
    const work = (async () => {
      let timer, value = null;
      try {
        if (item.status() !== 200) return;
        const data = await Promise.race([item.json(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('dashboard_scope_body_timeout')), 5000);
        })]);
        const common = { sequence: tracked.sequence, status: item.status(), observedAtEpochMs: Date.now() };
        value = tracked.key === 'settings'
          ? { ...common, source: 'normal-hosted-settings-response', doctorRef: data.doctor_id }
          : { ...common, source: 'normal-hosted-view-as-response', active: data.active, canViewAs: data.can_view_as,
            readOnly: data.read_only, requestBinding: data.request_binding, actorDoctorRef: data.actor === null ? null : data.actor?.doctor_id,
            targetPresent: data.target !== null };
      } catch { /* An unreadable newest response leaves the current proof absent. */ }
      finally {
        clearTimeout(timer);
        if (!disposed && cells[tracked.key].sequence === tracked.sequence) cells[tracked.key].value = value;
      }
    })();
    pending.add(work); work.finally(() => pending.delete(work));
  };
  page.on('request', request); page.on('response', response);
  const snapshot = () => ({ settings: cells.settings.value, viewAs: cells.viewAs.value });
  async function read({ expectedIdentitySHA256, expectedDoctorRef, signal, minimumSequences = {}, timeoutMs = 5000 }) {
    const deadline = Date.now() + timeoutMs;
    await page.waitForFunction(() => Boolean(window.Clerk?.loaded && window.Clerk?.user?.id && window.Clerk?.session?.id));
    while (!disposed) {
      signal.throwIfAborted();
      await Promise.allSettled([...pending]);
      const sequences = [cells.settings.sequence, cells.viewAs.sequence], current = snapshot();
      if (current.settings && current.viewAs && cells.settings.sequence >= (minimumSequences.settings ?? 0)
        && cells.viewAs.sequence >= (minimumSequences.viewAs ?? 0)) {
        // Read Clerk after all current response work, then ensure no response
        // generation changed while that native browser read was in flight.
        const identity = await page.evaluate(() => ({ userId: window.Clerk?.user?.id, sessionId: window.Clerk?.session?.id }));
        signal.throwIfAborted();
        if (cells.settings.sequence !== sequences[0] || cells.viewAs.sequence !== sequences[1]) continue;
        return assertDashboardAccountScope({ ...current, expectedIdentitySHA256, expectedDoctorRef,
          identitySHA256: typeof identity.userId === 'string' ? sha256(identity.userId) : null,
          hostedSessionSHA256: typeof identity.sessionId === 'string' ? sha256(identity.sessionId) : null });
      }
      if (Date.now() >= deadline) throw Error('dashboard_account_response_not_observed');
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    throw Error('dashboard_account_observer_closed');
  }
  return {
    read, snapshot,
    async prime(options) {
      // Retire the prior document before navigation. An older body completing
      // while the new app loads must not refill this navigation's cells.
      for (const cell of Object.values(cells)) { cell.value = null; cell.sequence++; }
      const minimumSequences = { settings: cells.settings.sequence + 1, viewAs: cells.viewAs.sequence + 1 };
      options.signal.throwIfAborted();
      await page.goto(`${DASHBOARD_ORIGIN}/settings`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ state: 'visible' });
      return read({ ...options, minimumSequences });
    },
    async dispose() {
      disposed = true; cells.settings.value = null; cells.viewAs.value = null;
      page.off('request', request); page.off('response', response); await Promise.allSettled([...pending]);
    },
  };
}

/** The native adapter supplies this projection of a normal saved/read draft
 * response, already bound to its run, mounted visit and admitted session. */
export function validateSavedReceipt(receipt, scenario) {
  if (receipt?.source !== 'normal-core-note-response' || !['read', 'prepare', 'save'].includes(receipt.action) || !uuid(receipt.runId)
      || receipt.action !== 'save' && !receipt.saveCompletion
      || receipt.runId !== scenario.admissionBinding?.runId || !uuid(receipt.workspaceId)
      || !ref(receipt.appointmentRef, 'appointment') || !uuid(receipt.session_id)
      || receipt.status !== 'draft' || !ref(receipt.note_ref, 'visit_note')
      || !ref(receipt.transcript_ref, 'ai_visit_transcript') || !digest(receipt.note_sha256)
      || !uuid(receipt.requestNonce) || !digest(receipt.source_sha256) || !ref(receipt.schema_ref, 'doctor_note_schema')
      || !Number.isFinite(receipt.observedAtMonotonicMs)
      || !Number.isFinite(receipt.browserTimeOriginMs)
      || !Array.isArray(receipt.field_order) || receipt.field_order.length < 1 || receipt.field_order.length > 100
      || receipt.field_order.some(field => typeof field !== 'string' || !field.trim() || field.length > 200)
      || new Set(receipt.field_order).size !== receipt.field_order.length) throw Error('native_saved_note_receipt_required');
  if (receipt.action !== 'save' || receipt.saveCompletion) {
    const validate = receipt.saveCompletion?.source === 'normal-desktop-save-completion' ? validateDesktopSaveCompletion : validateSaveCompletion;
    validate(receipt, receipt.saveCompletion);
  }
  return receipt;
}

export function validateDashboardConfig(config) {
  if (!config || config.syntheticOnly !== true || JSON.stringify(config).includes('REPLACE_')
      || !digest(config.identitySHA256) || !digest(config.storageStateSHA256)
      || typeof config.storageState !== 'string' || typeof config.playwrightPath !== 'string') throw Error('dashboard_configuration_incomplete');
  const api = new URL(config.apiOrigin);
  if (api.protocol !== 'https:' || !/^staging(?:-[a-z0-9]+)?\.cosmaneura\.com$/.test(api.hostname)
      || api.origin !== config.apiOrigin || api.username || api.password) throw Error('staging_dashboard_required');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000)) throw Error('dashboard_deadline_invalid');
  if (!Array.isArray(config.expectedVisiblePhrases) || !config.expectedVisiblePhrases.length
      || config.expectedVisiblePhrases.length > 20 || config.expectedVisiblePhrases.some(value =>
        typeof value !== 'string' || !value.trim() || value.length > 1000)) throw Error('dashboard_expected_saved_text_required');
  return config;
}

/** Ordinary page response only. Never fetch this endpoint separately. Reject an
 * old/different note even if another version makes the page say Note ready. */
export function projectNoteDetail(data, receipt) {
  if (data?.appointment?.id !== receipt.appointmentRef || !Array.isArray(data.notes)) throw Error('dashboard_appointment_mismatch');
  const notes = data.notes.filter(note => note.id === receipt.note_ref);
  if (notes.length !== 1) throw Error('dashboard_saved_note_missing');
  const note = notes[0];
  if (note.appointment_id !== receipt.appointmentRef || note.doctor_id !== data.appointment.doctor_id || note.ai_transcript_id !== receipt.transcript_ref
      || !note.note || typeof note.note !== 'object' || Array.isArray(note.note)
      || JSON.stringify(Object.keys(note.note)) !== JSON.stringify(receipt.field_order)
      || Object.values(note.note).some(value => typeof value !== 'string')
      || sha256(JSON.stringify(receipt.field_order.map(field => [field, note.note[field]]))) !== receipt.note_sha256) throw Error('dashboard_saved_note_mismatch');
  const candidates = [...(data.note_transcripts ?? []), ...(data.transcript ? [data.transcript] : [])]
    .filter(transcript => transcript.id === receipt.transcript_ref);
  if (!candidates.length || candidates.some(transcript => transcript.appointment_id !== receipt.appointmentRef
      || transcript.doctor_id !== note.doctor_id || transcript.patient_id !== data.appointment.patient_id
      || transcript.deleted_at || !Array.isArray(transcript.transcript_data) || !transcript.transcript_data.length)) throw Error('dashboard_source_transcript_mismatch');
  const transcript = candidates[0];
  if (candidates.some(item => sha256(JSON.stringify(item)) !== sha256(JSON.stringify(transcript)))) throw Error('dashboard_source_transcript_ambiguous');
  if (transcript.transcript_data.some(item => typeof item.content !== 'string' || !item.content.trim()
      || !Number.isSafeInteger(item.startTime) || !Number.isSafeInteger(item.endTime) || item.endTime <= item.startTime)) throw Error('dashboard_source_transcript_invalid');
  return { appointmentRef: data.appointment.id, doctorRef: note.doctor_id, noteRef: note.id, transcriptRef: transcript.id,
    nativeSessionId: receipt.session_id, noteSHA256: receipt.note_sha256, fieldOrder: [...receipt.field_order],
    transcriptSHA256: sha256(JSON.stringify(transcript.transcript_data)), transcriptSegments: transcript.transcript_data.length,
    transcriptDurationSeconds: transcript.duration, noteCreatedAt: note.created_at, transcriptCreatedAt: transcript.created_at };
}

/** The current Core notes layout requires its ordinary doctor-owned list before
 * rendering a detail route. Enable that exact read only after normal synthetic
 * account verification; query parameters do not scope it. Other records stay blocked. */
export function dashboardRequestAllowed(url, method, { apiOrigin, appointmentRef, noteRef, allowOwnedNotesList = false }) {
  const parsed = new URL(url);
  if (parsed.origin === DASHBOARD_ORIGIN && /^\/notes(?:\/|$)/.test(parsed.pathname))
    return parsed.pathname === `/notes/${appointmentRef}` && ![...parsed.searchParams.keys()].some(key => key !== 'reviewNote')
      && (!parsed.searchParams.has('reviewNote') || parsed.searchParams.get('reviewNote') === noteRef);
  if (!parsed.pathname.startsWith('/internal/')) return true;
  if (parsed.origin !== apiOrigin) return false;
  if (method !== 'GET') return false;
  if (parsed.pathname === '/internal/v1/notes')
    return allowOwnedNotesList === true && parsed.href === `${apiOrigin}/internal/v1/notes`;
  const path = parsed.pathname.replace(/^\/internal\/v1/, '');
  return path === `/notes/${appointmentRef}` || ['/settings', '/practice', '/practice/organization-access', '/view-as/status'].includes(path);
}

/** Complete only the two optional setup controls; never join, attest or sign in.
 * Caller owns a normal hosted context and may block the resulting notes route. */
export async function completeOptionalOnboarding(page, { signal }) {
  signal.throwIfAborted();
  if (await page.getByRole('button', { name: 'Start using Cosmas', exact: true }).count()) {
    await page.getByRole('button', { name: 'Start using Cosmas', exact: true }).click();
  }
  await page.getByRole('heading', { name: "You're all set!", exact: true }).waitFor();
  signal.throwIfAborted();
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/internal/v1/onboarding/complete'
    && item.request().method() === 'POST');
  void response.catch(() => {});
  await page.getByRole('button', { name: 'Go to Cosmas', exact: true }).click();
  const actual = await response; signal.throwIfAborted();
  if (!actual.ok()) throw Error('normal_onboarding_completion_failed');
  return { source: 'normal-hosted-onboarding-response', status: actual.status(), observedAtEpochMs: Date.now() };
}

export async function verifyDashboard({ config, scenario, savedReceipt, output, signal }) {
  if (!(signal instanceof AbortSignal)) throw Error('dashboard_signal_required');
  validateDashboardConfig(config); validateSavedReceipt(savedReceipt, scenario);
  if (scenario.executionKind !== 'live') throw Error('dashboard_requires_live_scenario');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const active = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 45000)]);
  active.throwIfAborted();
  const statePath = await realpath(config.storageState), stateBytes = await readFile(statePath);
  if (!(await stat(statePath)).isFile() || sha256(stateBytes) !== config.storageStateSHA256) throw Error('hosted_session_store_changed');
  const state = JSON.parse(stateBytes);
  let browser, context, page, closePromise, closed = false;
  const close = () => {
    if (!browser) return Promise.resolve();
    closePromise ??= browser.close().then(() => { closed = true; }).catch(error => { closePromise = null; throw error; });
    return closePromise;
  };
  const aborted = () => { void close().catch(() => {}); };
  active.addEventListener('abort', aborted, { once: true });
  const receipt = { origin: 'product-ui', executionKind: 'live', action: 'dashboard', targetId: scenario.targetId,
    checks: [], networkBoundary: [], nativeSavedReceiptSHA256: sha256(JSON.stringify(savedReceipt)),
    savedPassagePlayback: { status: 'NOT_RUN', reason: 'dashboard_has_no_saved_audio_player' } };
  let lastDetail, accountObserver, expectedTranscriptText = [], responseSequence = 0;
  const requestSequences = new WeakMap();
  const responseWork = new Set();
  try {
    const { chromium } = await import(pathToFileURL(resolve(config.playwrightPath)).href);
    browser = await chromium.launch({ headless: true, timeout: 30000 }); active.throwIfAborted();
    context = await browser.newContext({ storageState: state, serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(Math.min(config.timeoutMs ?? 30000, 30000));
    const boundary = { apiOrigin: config.apiOrigin, appointmentRef: savedReceipt.appointmentRef, noteRef: savedReceipt.note_ref };
    await context.route('**/*', async route => {
      const request = route.request();
      if (!dashboardRequestAllowed(request.url(), request.method(), boundary)) {
        receipt.networkBoundary.push({ method: request.method(), path: new URL(request.url()).pathname, action: 'blocked' });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    accountObserver = observeDashboardAccount(page, config.apiOrigin);
    page.on('request', request => {
      if (request.url() === `${config.apiOrigin}/internal/v1/notes/${savedReceipt.appointmentRef}` && request.method() === 'GET') {
        requestSequences.set(request, ++responseSequence); lastDetail = null; expectedTranscriptText = [];
      }
    });
    page.on('response', response => {
      const sequence = requestSequences.get(response.request());
      if (sequence === undefined) return;
      const work = (async () => {
        const observation = { sequence, status: response.status(), observedAtEpochMs: Date.now() };
        try {
          if (!response.ok()) throw Error('dashboard_detail_unavailable');
          const data = await response.json();
          observation.binding = projectNoteDetail(data, savedReceipt);
          if (sequence === responseSequence) expectedTranscriptText = [...(data.note_transcripts ?? []), data.transcript]
            .find(item => item?.id === savedReceipt.transcript_ref).transcript_data.map(item => item.content);
        } catch (error) { observation.failureCode = failure(error); }
        if (sequence === responseSequence) lastDetail = observation;
      })();
      responseWork.add(work); work.finally(() => responseWork.delete(work));
    });
    // Normal Settings navigation supplies the ordinary provider's doctor ID.
    // No API fetch or support impersonation is introduced. The ordinary Core
    // layout may read this verified synthetic doctor's own notes sidebar.
    const accountOptions = { expectedIdentitySHA256: config.identitySHA256, signal: active };
    receipt.initialAccount = await accountObserver.prime(accountOptions);
    boundary.allowOwnedNotesList = true;
    receipt.notesListScope = { source: 'normal-hosted-account-observation',
      doctorRef: receipt.initialAccount.doctorRef, identitySHA256: receipt.initialAccount.identitySHA256,
      method: 'GET', path: '/internal/v1/notes', queryAllowed: false };
    receipt.identitySHA256 = receipt.initialAccount.identitySHA256;
    receipt.hostedSessionSHA256 = receipt.initialAccount.hostedSessionSHA256;
    active.throwIfAborted();
    const url = `${DASHBOARD_ORIGIN}/notes/${savedReceipt.appointmentRef}?reviewNote=${savedReceipt.note_ref}`;
    receipt.uiStage = 'open_saved_note';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const note = page.locator(`[data-note-viewer][id="note-${savedReceipt.note_ref}"]`);
    await note.waitFor({ state: 'visible' });
    receipt.uiStage = 'note_ready';
    await page.getByText('Note ready', { exact: true }).first().waitFor({ state: 'visible' });
    await Promise.allSettled([...responseWork]);
    if (!lastDetail?.binding) throw Error(lastDetail?.failureCode ?? 'dashboard_detail_not_observed');
    const savedDetail = lastDetail;
    receipt.savedAccount = await accountObserver.read({ ...accountOptions, expectedDoctorRef: savedDetail.binding.doctorRef });
    if (lastDetail !== savedDetail) throw Error('dashboard_detail_changed_during_identity_read');
    receipt.detail = savedDetail;
    const headings = await note.locator('h3').allTextContents();
    receipt.checks.push({ locator: '#note-' + savedReceipt.note_ref, kind: 'attribute', actual: await note.getAttribute('id'), expected: 'note-' + savedReceipt.note_ref },
      { locator: 'Note ready', kind: 'text', actual: await page.getByText('Note ready', { exact: true }).first().innerText(), expected: 'Note ready' },
      { locator: 'saved-note-sections', kind: 'text', actual: JSON.stringify(headings), expected: JSON.stringify(savedReceipt.field_order) });
    const visible = await note.innerText();
    for (const phrase of config.expectedVisiblePhrases) receipt.checks.push({ locator: 'saved-note-content', kind: 'visible', actual: visible.includes(phrase), expected: true });
    if (headings.length !== savedReceipt.field_order.length || receipt.checks.some(check => check.actual !== check.expected)) throw Error('dashboard_rendered_note_mismatch');
    const transcriptToggle = page.getByRole('button', { name: 'Visit Transcript', exact: true });
    receipt.uiStage = 'source_transcript';
    if (await transcriptToggle.count() !== 1) throw Error('dashboard_transcript_ui_ambiguous');
    await transcriptToggle.click();
    const expanded = await transcriptToggle.getAttribute('aria-expanded');
    receipt.checks.push({ locator: 'Visit Transcript', kind: 'attribute', actual: expanded, expected: 'true' });
    if (expanded !== 'true') throw Error('dashboard_transcript_not_rendered');
    const panel = page.locator(`[id="${await transcriptToggle.getAttribute('aria-controls')}"]`);
    const transcriptText = await panel.innerText();
    if (!expectedTranscriptText.every(text => transcriptText.includes(text))) throw Error('dashboard_transcript_text_mismatch');
    receipt.renderedTranscriptSHA256 = sha256(transcriptText);
    // Refresh normal account proof, then reopen the same exact note route.
    // Require a new detail request; a late prior reply cannot satisfy it.
    boundary.allowOwnedNotesList = false;
    await accountObserver.prime({ ...accountOptions, expectedDoctorRef: receipt.detail.binding.doctorRef });
    boundary.allowOwnedNotesList = true;
    const beforeReload = responseSequence;
    receipt.uiStage = 'reopen_saved_note';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-note-viewer][id="note-${savedReceipt.note_ref}"]`).waitFor({ state: 'visible' });
    await Promise.allSettled([...responseWork]);
    if (responseSequence <= beforeReload || !lastDetail?.binding) throw Error('dashboard_reopen_not_observed');
    const reopenedDetail = lastDetail;
    receipt.reopenedAccount = await accountObserver.read({ ...accountOptions, expectedDoctorRef: reopenedDetail.binding.doctorRef });
    if (lastDetail !== reopenedDetail) throw Error('dashboard_detail_changed_during_identity_read');
    if (receipt.reopenedAccount.doctorRef !== receipt.savedAccount.doctorRef) throw Error('dashboard_actor_scope_mismatch');
    receipt.reopenedDetail = reopenedDetail;
    await note.screenshot({ path: resolve(output, 'dashboard-saved-note.png') });
    receipt.uiStage = 'complete';
  } catch (error) {
    receipt.failureCode = active.aborted ? 'dashboard_aborted' : failure(error);
    receipt.detail ??= lastDetail;
    receipt.checks.push({ locator: 'dashboard-verification', kind: 'text', actual: receipt.failureCode, expected: 'observed' });
    if (receipt.initialAccount && page && !page.isClosed()) {
      const evidence = new AbortController();
      let evidenceTimer;
      try {
        const currentAccount = await Promise.race([
          accountObserver.read({ expectedIdentitySHA256: config.identitySHA256,
            expectedDoctorRef: receipt.initialAccount.doctorRef,
            signal: AbortSignal.any([active, evidence.signal]), timeoutMs: 1000 }),
          new Promise((_, reject) => { evidenceTimer = setTimeout(() => {
            evidence.abort(); reject(Error('dashboard_failure_scope_timeout'));
          }, 1500); }),
        ]);
        active.throwIfAborted();
        if (currentAccount.hostedSessionSHA256 === receipt.initialAccount.hostedSessionSHA256) {
          const filename = 'dashboard-failure.png';
          const bytes = await page.screenshot({ path: resolve(output, filename), timeout: 1500 });
          receipt.failureScreenshot = { file: filename, sha256: sha256(bytes) };
        } else receipt.failureScreenshot = { status: 'unavailable' };
      } catch { receipt.failureScreenshot = { status: 'unavailable' }; }
      finally { clearTimeout(evidenceTimer); evidence.abort(); }
    }
  } finally {
    active.removeEventListener('abort', aborted);
    await close().catch(() => {});
    if (browser && !closed) await close().catch(() => {});
    await Promise.allSettled([...responseWork]);
    receipt.lastAccountResponses = accountObserver?.snapshot();
    await accountObserver?.dispose();
    receipt.cleanup = { ownedResourcesSettled: !browser || closed, ownedBrowserClosed: !browser || closed };
    receipt.observedAtEpochMs = Date.now();
    await atomicJSON(resolve(output, 'dashboard-observation.json'), receipt);
  }
  return receipt;
}

export function assertIsolationResponse({ status, identitySHA256, expectedIdentitySHA256, hostedSessionSHA256,
  settings, viewAs, viewerDoctorRef, now }) {
  if (![403, 404].includes(status)) throw Error('cross_account_denial_not_observed');
  if (!ref(viewerDoctorRef, 'doctor')) throw Error('isolation_actor_scope_mismatch');
  let account;
  try { account = assertDashboardAccountScope({ settings, viewAs, identitySHA256, hostedSessionSHA256,
    expectedIdentitySHA256, expectedDoctorRef: viewerDoctorRef, now }); }
  catch { throw Error('isolation_actor_scope_mismatch'); }
  return { httpStatus: status, identitySHA256, actorDoctorRef: account.doctorRef, doctorSource: 'normal-settings-response',
    activeViewAs: viewAs.active, viewAsTargetPresent: viewAs.targetPresent };
}

/** Real normal UI navigation to the other account's exact synthetic note. A
 * 200, 401, missing response, blocked list, or a UI error never proves denial.
 * The denied body is not retained or inspected. */
export async function verifyDashboardIsolation({ config, scenario, foreignScenario, foreignSavedReceipt, viewerDoctorRef, output, signal }) {
  if (!(signal instanceof AbortSignal)) throw Error('dashboard_signal_required');
  validateDashboardConfig(config); validateSavedReceipt(foreignSavedReceipt, foreignScenario);
  if (scenario.executionKind !== 'live' || foreignScenario.executionKind !== 'live'
      || scenario.admissionBinding.runId === foreignSavedReceipt.runId || !ref(viewerDoctorRef, 'doctor')) throw Error('isolation_distinct_accounts_required');
  const active = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 45000)]);
  active.throwIfAborted();
  await mkdir(output, { recursive: true, mode: 0o700 });
  const stateBytes = await readFile(await realpath(config.storageState));
  if (sha256(stateBytes) !== config.storageStateSHA256) throw Error('hosted_session_store_changed');
  let browser, page, accountObserver, closing, closed = false;
  const close = () => !browser ? Promise.resolve() : closing ??= browser.close().then(() => { closed = true; })
    .catch(error => { closing = null; throw error; });
  const abort = () => { void close().catch(() => {}); };
  active.addEventListener('abort', abort, { once: true });
  const observation = { origin: 'product-ui', executionKind: 'live', action: 'dashboard_isolation', targetId: scenario.targetId,
    requestedAppointmentRef: foreignSavedReceipt.appointmentRef, requestedNoteRef: foreignSavedReceipt.note_ref,
    foreignSavedReceiptSHA256: sha256(JSON.stringify(foreignSavedReceipt)), blockedRequests: [] };
  try {
    const { chromium } = await import(pathToFileURL(resolve(config.playwrightPath)).href);
    browser = await chromium.launch({ headless: true, timeout: 30000 }); active.throwIfAborted();
    const context = await browser.newContext({ storageState: JSON.parse(stateBytes), serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(Math.min(config.timeoutMs ?? 30000, 30000));
    const boundary = { apiOrigin: config.apiOrigin, appointmentRef: foreignSavedReceipt.appointmentRef, noteRef: foreignSavedReceipt.note_ref };
    await context.route('**/*', async route => {
      const request = route.request();
      if (!dashboardRequestAllowed(request.url(), request.method(), boundary)) {
        observation.blockedRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    accountObserver = observeDashboardAccount(page, config.apiOrigin);
    const accountOptions = { expectedIdentitySHA256: config.identitySHA256, expectedDoctorRef: viewerDoctorRef, signal: active };
    observation.initialAccount = await accountObserver.prime(accountOptions);
    active.throwIfAborted();
    const detail = page.waitForResponse(response => response.url() === `${config.apiOrigin}/internal/v1/notes/${foreignSavedReceipt.appointmentRef}`
      && response.request().method() === 'GET');
    void detail.catch(() => {});
    await page.goto(`${DASHBOARD_ORIGIN}/notes/${foreignSavedReceipt.appointmentRef}?reviewNote=${foreignSavedReceipt.note_ref}`, { waitUntil: 'domcontentloaded' });
    const actual = await detail;
    observation.httpStatus = actual.status();
    observation.currentAccount = await accountObserver.read(accountOptions);
    observation.identitySHA256 = observation.currentAccount.identitySHA256;
    observation.denial = assertIsolationResponse({ status: actual.status(), ...observation.currentAccount,
      expectedIdentitySHA256: config.identitySHA256, viewerDoctorRef });
    active.throwIfAborted();
  } catch (error) { observation.failureCode = active.aborted ? 'dashboard_aborted' : failure(error); }
  finally {
    active.removeEventListener('abort', abort);
    await close().catch(() => {}); if (browser && !closed) await close().catch(() => {});
    observation.lastAccountResponses = accountObserver?.snapshot();
    await accountObserver?.dispose();
    observation.cleanup = { ownedResourcesSettled: !browser || closed, ownedBrowserClosed: !browser || closed };
    observation.observedAtEpochMs = Date.now();
    await atomicJSON(resolve(output, 'isolation-observation.json'), observation);
  }
  return observation;
}
