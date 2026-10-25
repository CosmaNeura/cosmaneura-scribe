import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJSON, sha256 } from './journal.mjs';

export const DASHBOARD_ORIGIN = 'https://staging-app.cosmaneura.com';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ref = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).test(value);
const failure = error => /^[a-z_]{1,100}$/.test(error?.message) ? error.message : 'dashboard_ui_unavailable';

/** The native adapter supplies this projection of a normal saved/read draft
 * response, already bound to its run, mounted visit and admitted session. */
export function validateSavedReceipt(receipt, scenario) {
  if (receipt?.source !== 'normal-core-note-response' || receipt.action !== 'save' || !uuid(receipt.runId)
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

/** The current Core search filters an already-loaded list. Query parameters do
 * not scope /notes. Block broad lists and unrelated records before transmission. */
export function dashboardRequestAllowed(url, method, { apiOrigin, appointmentRef, noteRef }) {
  const parsed = new URL(url);
  if (parsed.origin === DASHBOARD_ORIGIN && /^\/notes(?:\/|$)/.test(parsed.pathname))
    return parsed.pathname === `/notes/${appointmentRef}` && ![...parsed.searchParams.keys()].some(key => key !== 'reviewNote')
      && (!parsed.searchParams.has('reviewNote') || parsed.searchParams.get('reviewNote') === noteRef);
  if (!parsed.pathname.startsWith('/internal/')) return true;
  if (parsed.origin !== apiOrigin) return false;
  if (method !== 'GET') return false;
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
  let lastDetail, lastViewAs, expectedTranscriptText = [], responseSequence = 0, viewAsSequence = 0;
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
    page.on('request', request => {
      if (request.url() === `${config.apiOrigin}/internal/v1/view-as/status`) {
        requestSequences.set(request, ++viewAsSequence); lastViewAs = null;
      }
    });
    page.on('response', response => {
      if (response.url() === `${config.apiOrigin}/internal/v1/view-as/status`) {
        const sequence = requestSequences.get(response.request());
        const work = (async () => {
          if (!response.ok()) return;
          const value = await response.json();
          if (sequence === viewAsSequence) lastViewAs = { active: value.active, actorDoctorRef: value.actor?.doctor_id, targetPresent: value.target !== null };
        })().catch(() => { if (sequence === viewAsSequence) lastViewAs = null; });
        responseWork.add(work); work.finally(() => responseWork.delete(work));
        return;
      }
      if (response.url() !== `${config.apiOrigin}/internal/v1/notes/${savedReceipt.appointmentRef}` || response.request().method() !== 'GET') return;
      const sequence = ++responseSequence;
      const work = (async () => {
        const observation = { sequence, status: response.status(), observedAtEpochMs: Date.now() };
        try {
          if (!response.ok()) throw Error('dashboard_detail_unavailable');
          const data = await response.json();
          observation.binding = projectNoteDetail(data, savedReceipt);
          if (!lastDetail || sequence >= lastDetail.sequence) expectedTranscriptText = [...(data.note_transcripts ?? []), data.transcript]
            .find(item => item?.id === savedReceipt.transcript_ref).transcript_data.map(item => item.content);
        } catch (error) { observation.failureCode = failure(error); }
        if (!lastDetail || sequence >= lastDetail.sequence) lastDetail = observation;
      })();
      responseWork.add(work); work.finally(() => responseWork.delete(work));
    });
    // Establish identity without loading a notes list. This is a normal hosted
    // page and passive Clerk state read, not token creation or session injection.
    await page.goto(`${DASHBOARD_ORIGIN}/onboarding`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Clerk?.loaded && window.Clerk?.user?.id));
    const identity = await page.evaluate(() => ({ userId: window.Clerk.user.id, sessionId: window.Clerk.session?.id }));
    if (!identity.sessionId || sha256(identity.userId) !== config.identitySHA256) throw Error('hosted_account_identity_mismatch');
    receipt.identitySHA256 = sha256(identity.userId);
    receipt.hostedSessionSHA256 = sha256(identity.sessionId);
    active.throwIfAborted();
    const url = `${DASHBOARD_ORIGIN}/notes/${savedReceipt.appointmentRef}?reviewNote=${savedReceipt.note_ref}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const note = page.locator(`[data-note-viewer][id="note-${savedReceipt.note_ref}"]`);
    await note.waitFor({ state: 'visible' });
    await page.getByText('Note ready', { exact: true }).first().waitFor({ state: 'visible' });
    await Promise.allSettled([...responseWork]);
    if (!lastDetail?.binding) throw Error(lastDetail?.failureCode ?? 'dashboard_detail_not_observed');
    if (lastViewAs?.active !== false || lastViewAs.targetPresent !== false || lastViewAs.actorDoctorRef !== lastDetail.binding.doctorRef) throw Error('dashboard_actor_scope_mismatch');
    receipt.detail = lastDetail;
    const headings = await note.locator('h3').allTextContents();
    receipt.checks.push({ locator: '#note-' + savedReceipt.note_ref, kind: 'attribute', actual: await note.getAttribute('id'), expected: 'note-' + savedReceipt.note_ref },
      { locator: 'Note ready', kind: 'text', actual: await page.getByText('Note ready', { exact: true }).first().innerText(), expected: 'Note ready' },
      { locator: 'saved-note-sections', kind: 'text', actual: JSON.stringify(headings), expected: JSON.stringify(savedReceipt.field_order) });
    const visible = await note.innerText();
    for (const phrase of config.expectedVisiblePhrases) receipt.checks.push({ locator: 'saved-note-content', kind: 'visible', actual: visible.includes(phrase), expected: true });
    if (headings.length !== savedReceipt.field_order.length || receipt.checks.some(check => check.actual !== check.expected)) throw Error('dashboard_rendered_note_mismatch');
    const transcriptToggle = page.getByRole('button', { name: 'Visit Transcript', exact: true });
    if (await transcriptToggle.count() !== 1) throw Error('dashboard_transcript_ui_ambiguous');
    await transcriptToggle.click();
    const expanded = await transcriptToggle.getAttribute('aria-expanded');
    receipt.checks.push({ locator: 'Visit Transcript', kind: 'attribute', actual: expanded, expected: 'true' });
    if (expanded !== 'true') throw Error('dashboard_transcript_not_rendered');
    const panel = page.locator(`[id="${await transcriptToggle.getAttribute('aria-controls')}"]`);
    const transcriptText = await panel.innerText();
    if (!expectedTranscriptText.every(text => transcriptText.includes(text))) throw Error('dashboard_transcript_text_mismatch');
    receipt.renderedTranscriptSHA256 = sha256(transcriptText);
    // Reopen through the same normal route to establish persistence, preserving
    // the first read and requiring a second real detail response.
    const beforeReload = responseSequence;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(`[data-note-viewer][id="note-${savedReceipt.note_ref}"]`).waitFor({ state: 'visible' });
    await Promise.allSettled([...responseWork]);
    if (responseSequence <= beforeReload || !lastDetail?.binding) throw Error('dashboard_reopen_not_observed');
    if (lastViewAs?.active !== false || lastViewAs.targetPresent !== false || lastViewAs.actorDoctorRef !== lastDetail.binding.doctorRef
        || await page.evaluate(() => window.Clerk?.user?.id) !== identity.userId) throw Error('dashboard_actor_scope_mismatch');
    receipt.reopenedDetail = lastDetail;
    await note.screenshot({ path: resolve(output, 'dashboard-saved-note.png') });
  } catch (error) {
    receipt.failureCode = active.aborted ? 'dashboard_aborted' : failure(error);
    receipt.detail ??= lastDetail;
    receipt.checks.push({ locator: 'dashboard-verification', kind: 'text', actual: receipt.failureCode, expected: 'observed' });
  } finally {
    active.removeEventListener('abort', aborted);
    await close().catch(() => {});
    if (browser && !closed) await close().catch(() => {});
    await Promise.allSettled([...responseWork]);
    receipt.cleanup = { ownedResourcesSettled: !browser || closed, ownedBrowserClosed: !browser || closed };
    receipt.observedAtEpochMs = Date.now();
    await atomicJSON(resolve(output, 'dashboard-observation.json'), receipt);
  }
  return receipt;
}

export function assertIsolationResponse({ status, identitySHA256, expectedIdentitySHA256, viewAs, viewerDoctorRef }) {
  if (![403, 404].includes(status)) throw Error('cross_account_denial_not_observed');
  if (identitySHA256 !== expectedIdentitySHA256 || viewAs?.active !== false || viewAs.targetPresent !== false
      || !ref(viewerDoctorRef, 'doctor') || viewAs.actorDoctorRef !== viewerDoctorRef) throw Error('isolation_actor_scope_mismatch');
  return { httpStatus: status, identitySHA256, actorDoctorRef: viewAs.actorDoctorRef,
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
  let browser, page, closing, closed = false, viewAs, sequence = 0;
  const pending = new Set(), requestSequences = new WeakMap();
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
    page.on('request', request => {
      if (request.url() === `${config.apiOrigin}/internal/v1/view-as/status`) { requestSequences.set(request, ++sequence); viewAs = null; }
    });
    page.on('response', response => {
      if (response.url() !== `${config.apiOrigin}/internal/v1/view-as/status`) return;
      const observedSequence = requestSequences.get(response.request());
      const work = (async () => {
        if (!response.ok()) return;
        const value = await response.json();
        if (observedSequence === sequence) viewAs = { active: value.active, actorDoctorRef: value.actor?.doctor_id, targetPresent: value.target !== null };
      })().catch(() => { if (observedSequence === sequence) viewAs = null; });
      pending.add(work); work.finally(() => pending.delete(work));
    });
    await page.goto(`${DASHBOARD_ORIGIN}/onboarding`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.Clerk?.loaded && window.Clerk?.user?.id && window.Clerk?.session?.id));
    const initialIdentity = await page.evaluate(() => window.Clerk.user.id);
    if (sha256(initialIdentity) !== config.identitySHA256) throw Error('hosted_account_identity_mismatch');
    active.throwIfAborted();
    const detail = page.waitForResponse(response => response.url() === `${config.apiOrigin}/internal/v1/notes/${foreignSavedReceipt.appointmentRef}`
      && response.request().method() === 'GET');
    void detail.catch(() => {});
    await page.goto(`${DASHBOARD_ORIGIN}/notes/${foreignSavedReceipt.appointmentRef}?reviewNote=${foreignSavedReceipt.note_ref}`, { waitUntil: 'domcontentloaded' });
    const actual = await detail;
    observation.httpStatus = actual.status();
    await Promise.allSettled([...pending]);
    const currentIdentity = await page.evaluate(() => window.Clerk?.user?.id);
    observation.identitySHA256 = typeof currentIdentity === 'string' ? sha256(currentIdentity) : null;
    observation.denial = assertIsolationResponse({ status: actual.status(), identitySHA256: observation.identitySHA256,
      expectedIdentitySHA256: config.identitySHA256, viewAs, viewerDoctorRef });
    active.throwIfAborted();
  } catch (error) { observation.failureCode = active.aborted ? 'dashboard_aborted' : failure(error); }
  finally {
    active.removeEventListener('abort', abort);
    await close().catch(() => {}); if (browser && !closed) await close().catch(() => {});
    await Promise.allSettled([...pending]);
    observation.cleanup = { ownedResourcesSettled: !browser || closed, ownedBrowserClosed: !browser || closed };
    observation.observedAtEpochMs = Date.now();
    await atomicJSON(resolve(output, 'isolation-observation.json'), observation);
  }
  return observation;
}
