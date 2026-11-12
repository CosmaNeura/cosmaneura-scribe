import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './journal.mjs';
import { DASHBOARD_ORIGIN, assertDashboardAccountScope, assertIsolationResponse, completeOptionalOnboarding,
  dashboardRequestAllowed, observeDashboardAccount, projectNoteDetail, validateSavedReceipt, verifyDashboard } from './dashboard.mjs';

const id = '01m5q661ryetaa28yxe7vbqrex', uuid = '11111111-1111-4111-8111-111111111111';
const fields = { Assessment: 'Invented headache.', Plan: 'Synthetic saved correction.' };
function receipt() { return { source: 'normal-core-note-response', action: 'save', runId: uuid, workspaceId: uuid,
  appointmentRef: 'appointment_' + id, session_id: uuid, status: 'draft', note_ref: 'visit_note_' + id,
  transcript_ref: 'ai_visit_transcript_' + id, note_sha256: sha256(JSON.stringify(Object.entries(fields))), field_order: Object.keys(fields),
  source_sha256: 'a'.repeat(64), schema_ref: 'doctor_note_schema_' + id, requestNonce: uuid,
  observedAtMonotonicMs: 12, browserTimeOriginMs: Date.now() - 12 }; }
function detail() {
  const r = receipt(), doctor = 'doctor_' + id, patient = 'patient_' + id;
  const transcript = { id: r.transcript_ref, appointment_id: r.appointmentRef, doctor_id: doctor, patient_id: patient,
    duration: 2, created_at: new Date().toISOString(), deleted_at: null,
    transcript_data: [{ speaker: 'Speaker 1', content: 'Invented headache.', startTime: 0, endTime: 2000 }] };
  return { appointment: { id: r.appointmentRef, doctor_id: doctor, patient_id: patient },
    notes: [{ id: r.note_ref, appointment_id: r.appointmentRef, doctor_id: doctor, ai_transcript_id: r.transcript_ref, note: fields }],
    transcript, note_transcripts: [transcript] };
}

test('dashboard binds the exact saved native session through note and transcript IDs plus ordered content hash', () => {
  const r = validateSavedReceipt(receipt(), { admissionBinding: { runId: uuid } });
  const actual = projectNoteDetail(detail(), r);
  assert.equal(actual.nativeSessionId, uuid);
  assert.equal(actual.noteSHA256, r.note_sha256);
  assert.equal(actual.transcriptSegments, 1);
  assert.equal(Object.hasOwn(actual, 'note'), false);
});
test('a different saved version or transcript cannot qualify an otherwise ready page', () => {
  for (const mutate of [data => { data.notes[0].id += '0'; }, data => { data.notes[0].ai_transcript_id += '0'; },
    data => { data.notes[0].note = { ...fields, Plan: 'Old unsaved content.' }; },
    data => { data.notes[0].note = { Plan: fields.Plan, Assessment: fields.Assessment }; },
    data => { data.notes[0].doctor_id += '0'; }, data => { data.transcript.deleted_at = new Date().toISOString(); }]) {
    const data = detail(); mutate(data); assert.throws(() => projectNoteDetail(data, receipt()), /dashboard_/);
  }
});
test('missing native provenance and ambiguous source versions fail closed', () => {
  assert.throws(() => validateSavedReceipt({ ...receipt(), source: 'configured-receipt' }, { admissionBinding: { runId: uuid } }), /receipt_required/);
  assert.throws(() => validateSavedReceipt({ ...receipt(), action: 'read' }, { admissionBinding: { runId: uuid } }), /receipt_required/);
  const data = detail(); data.note_transcripts = [{ ...data.transcript, duration: 9 }];
  assert.throws(() => projectNoteDetail(data, receipt()), /ambiguous/);
});
test('only an exact visit request is allowed; list searches and a wrong API origin cannot broaden access', () => {
  const r = receipt(), scope = { apiOrigin: 'https://staging-api.cosmaneura.com', appointmentRef: r.appointmentRef, noteRef: r.note_ref };
  const api = scope.apiOrigin + '/internal/v1';
  assert.equal(dashboardRequestAllowed(`${api}/notes/${r.appointmentRef}`, 'GET', scope), true);
  assert.equal(dashboardRequestAllowed(`${DASHBOARD_ORIGIN}/notes/${r.appointmentRef}?reviewNote=${r.note_ref}`, 'GET', scope), true);
  for (const url of [`${api}/notes`, `${api}/notes?search=synthetic`, `${api}/patients`, `${api}/notes/appointment_other`,
    `https://staging-other.cosmaneura.com/internal/v1/notes`, `${DASHBOARD_ORIGIN}/notes`]) {
    assert.equal(dashboardRequestAllowed(url, 'GET', scope), false);
  }
  assert.equal(dashboardRequestAllowed(`${api}/notes/${r.appointmentRef}`, 'POST', scope), false);
});
test('verified synthetic account enables only the exact ordinary doctor-owned list read', () => {
  const r = receipt(), scope = { apiOrigin: 'https://staging-api.cosmaneura.com', appointmentRef: r.appointmentRef,
    noteRef: r.note_ref, allowOwnedNotesList: true }, api = scope.apiOrigin + '/internal/v1';
  assert.equal(dashboardRequestAllowed(`${api}/notes`, 'GET', scope), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    assert.equal(dashboardRequestAllowed(`${api}/notes`, method, scope), false);
  for (const url of [`${api}/notes?search=synthetic`, `${api}/notes?appointment_id=${r.appointmentRef}`,
    `${api}/notes#section`, `${api}/notes/`, `${api}/notes/appointment_other`, `${api}/patients`,
    'https://staging-other.cosmaneura.com/internal/v1/notes', 'https://someone@staging-api.cosmaneura.com/internal/v1/notes'])
    assert.equal(dashboardRequestAllowed(url, 'GET', scope), false);
  for (const allowOwnedNotesList of [undefined, false, 'true', 1])
    assert.equal(dashboardRequestAllowed(`${api}/notes`, 'GET', { ...scope, allowOwnedNotesList }), false);
});
test('optional onboarding submits only after the distinct Go to Cosmas control', async () => {
  const events = [];
  const page = { getByRole: (role, { name }) => ({ count: async () => 1,
    click: async () => { events.push(name); }, waitFor: async () => { events.push(name); } }),
  waitForResponse: async predicate => {
    const response = { url: () => 'https://staging-api.cosmaneura.com/internal/v1/onboarding/complete', request: () => ({ method: () => 'POST' }), ok: () => true, status: () => 200 };
    assert.equal(predicate(response), true); return response;
  } };
  const result = await completeOptionalOnboarding(page, { signal: new AbortController().signal });
  assert.deepEqual(events, ['Start using Cosmas', "You're all set!", 'Go to Cosmas']);
  assert.equal(result.status, 200);
});
test('cross-account isolation needs an actual 403/404 for the current inactive actor', () => {
  const sample = { ...accountSample(), viewerDoctorRef: 'doctor_' + id };
  for (const status of [403, 404]) assert.equal(assertIsolationResponse({ ...sample, status }).httpStatus, status);
  for (const status of [undefined, 200, 401, 500]) assert.throws(() => assertIsolationResponse({ ...sample, status }), /denial_not_observed/);
  assert.throws(() => assertIsolationResponse({ ...sample, status: 404, identitySHA256: 'b'.repeat(64) }), /actor_scope/);
  assert.throws(() => assertIsolationResponse({ ...sample, status: 404, viewAs: { ...sample.viewAs, active: true } }), /actor_scope/);
  assert.throws(() => assertIsolationResponse({ ...sample, status: 404, viewAs: null }), /actor_scope/);
});

function accountSample() {
  const common = { sequence: 1, status: 200, observedAtEpochMs: Date.now() };
  return { identitySHA256: sha256('user_a'), expectedIdentitySHA256: sha256('user_a'), hostedSessionSHA256: sha256('session_a'),
    expectedDoctorRef: 'doctor_' + id,
    settings: { ...common, source: 'normal-hosted-settings-response', doctorRef: 'doctor_' + id },
    viewAs: { ...common, source: 'normal-hosted-view-as-response', active: false, targetPresent: false,
      actorDoctorRef: null, canViewAs: false, readOnly: false, requestBinding: 'inactive' } };
}
test('ordinary provider actor-null is bound to fresh Settings doctor and current Clerk', () => {
  const sample = accountSample(), actual = assertDashboardAccountScope(sample);
  assert.equal(actual.doctorRef, sample.settings.doctorRef); assert.equal(actual.viewAs.actorDoctorRef, null);
  const privileged = { ...sample, viewAs: { ...sample.viewAs, canViewAs: true, actorDoctorRef: sample.settings.doctorRef } };
  assert.equal(assertDashboardAccountScope(privileged).doctorRef, sample.settings.doctorRef);
  assert.equal(assertIsolationResponse({ ...sample, viewerDoctorRef: sample.settings.doctorRef, status: 404 }).doctorSource, 'normal-settings-response');
});
test('missing, stale, active, unsupported or foreign identity evidence cannot qualify saved/reopened/denied scope', () => {
  const base = accountSample();
  for (const mutate of [s => { delete s.settings; }, s => { delete s.viewAs; }, s => { delete s.hostedSessionSHA256; },
    s => { s.identitySHA256 = sha256('other'); }, s => { s.settings.doctorRef += '0'; },
    s => { s.settings.observedAtEpochMs -= 16000; }, s => { s.viewAs.observedAtEpochMs = NaN; },
    s => { s.settings.observedAtEpochMs += 1000; }, s => { s.viewAs.sequence = 0; },
    s => { s.viewAs.active = true; }, s => { s.viewAs.targetPresent = true; }, s => { s.viewAs.readOnly = true; },
    s => { delete s.viewAs.canViewAs; }, s => { s.viewAs.canViewAs = true; }, s => { s.viewAs.requestBinding = 'other'; },
    s => { s.viewAs.actorDoctorRef = 'doctor_other'; }, s => { s.viewAs.actorDoctorRef = undefined; },
    s => { s.viewAs.canViewAs = true; s.viewAs.actorDoctorRef = 'doctor_other'; },
    s => { s.settings.status = 403; }, s => { s.viewAs.source = 'configured'; }]) {
    const sample = structuredClone(base); mutate(sample);
    assert.throws(() => assertDashboardAccountScope(sample), /dashboard_actor_scope/);
    assert.throws(() => assertIsolationResponse({ ...sample, viewerDoctorRef: base.settings.doctorRef, status: 404 }), /isolation_actor_scope/);
  }
});

const inactive = () => ({ active: false, actor: null, target: null, can_view_as: false, read_only: false, request_binding: 'inactive' });
const options = () => ({ expectedIdentitySHA256: sha256('user_a'), expectedDoctorRef: 'doctor_' + id, signal: new AbortController().signal, timeoutMs: 50 });
const tick = () => new Promise(resolve => setImmediate(resolve));
class ScopePage extends EventEmitter {
  userId = 'user_a'; sessionId = 'session_a'; visits = []; calls = 0;
  async waitForFunction() {}
  async evaluate() { this.calls++; return { userId: this.userId, sessionId: this.sessionId }; }
  getByRole(role, query) { assert.equal(role, 'heading'); assert.equal(query.name, 'Settings'); return { waitFor: async () => {} }; }
  request(path) {
    const request = { method: () => 'GET', url: () => `${DASHBOARD_ORIGIN}/internal/v1/${path}` }; this.emit('request', request); return request;
  }
  response(request, data, status = 200) {
    this.emit('response', { request: () => request, status: () => status, json: async () => data });
  }
  async goto(url) {
    this.visits.push(url);
    this.response(this.request('settings'), { doctor_id: 'doctor_' + id });
    this.response(this.request('view-as/status'), inactive());
  }
}
test('normal account verification precedes list allowance and a render failure retains its screenshot', { timeout: 10000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'scribe-dashboard-boundary-'));
  const key = 'dashboardBoundaryFixture' + Date.now();
  try {
    const statePath = join(folder, 'state.json'), playwrightPath = join(folder, 'playwright.mjs');
    await writeFile(statePath, '{}');
    await writeFile(playwrightPath, `export const chromium = { launch: async () => globalThis[${JSON.stringify(key)}] };`);
    for (const situation of ['verified', 'initial-wrong-account', 'later-wrong-account', 'later-session', 'in-flight-scope', 'failed-scope', 'late-clerk-proof']) {
      const wrongAccount = situation === 'initial-wrong-account';
      const page = new ScopePage();
      if (wrongAccount) page.userId = 'other_synthetic_user';
      let handler, finishLateProof, closed = false, noteNavigations = 0, listReads = 0;
      page.setDefaultTimeout = () => {};
      page.isClosed = () => closed;
      page.screenshot = async ({ path, timeout }) => {
        assert.equal(timeout, 1500);
        const bytes = Buffer.from('synthetic screenshot fixture'); await writeFile(path, bytes); return bytes;
      };
      page.locator = () => ({ waitFor: async () => { throw Error('test_render_failure'); } });
      page.goto = async url => {
        if (url.endsWith('/settings')) return ScopePage.prototype.goto.call(page, url);
        noteNavigations++;
        await handler({ request: () => ({ url: () => `${DASHBOARD_ORIGIN}/internal/v1/notes`, method: () => 'GET' }),
          continue: async () => { listReads++; }, abort: async () => { throw Error('required_list_blocked'); } });
        if (situation === 'later-wrong-account') page.userId = 'other_synthetic_user';
        if (situation === 'later-session') page.sessionId = 'different_session';
        if (situation === 'in-flight-scope') page.request('settings');
        if (situation === 'failed-scope') page.response(page.request('settings'), {}, 503);
        if (situation === 'late-clerk-proof') page.waitForFunction = async () => new Promise(resolve => { finishLateProof = resolve; });
      };
      globalThis[key] = { close: async () => { closed = true; },
        newContext: async () => ({ newPage: async () => page, route: async (_pattern, route) => { handler = route; } }) };
      const result = await verifyDashboard({
        config: { syntheticOnly: true, identitySHA256: sha256('user_a'), storageStateSHA256: sha256('{}'),
          storageState: statePath, playwrightPath, apiOrigin: DASHBOARD_ORIGIN, expectedVisiblePhrases: ['Synthetic saved correction.'] },
        scenario: { executionKind: 'live', targetId: 'synthetic', admissionBinding: { runId: uuid } },
        savedReceipt: receipt(), output: join(folder, situation), signal: new AbortController().signal,
      });
      // The optional proof must settle without this reply. Completing it later
      // cannot initiate a screenshot after the browser has been retired.
      if (finishLateProof) { finishLateProof(); await tick(); }
      assert.equal(result.cleanup.ownedResourcesSettled, true);
      assert.equal(result.failureCode, wrongAccount ? 'dashboard_actor_scope_mismatch' : 'test_render_failure');
      assert.equal(listReads, wrongAccount ? 0 : 1); assert.equal(noteNavigations, wrongAccount ? 0 : 1);
      if (!wrongAccount) {
        assert.equal(result.notesListScope.doctorRef, 'doctor_' + id);
        assert.equal(result.uiStage, 'open_saved_note');
        if (situation === 'verified') assert.equal(result.failureScreenshot.sha256,
          sha256(await readFile(join(folder, situation, result.failureScreenshot.file))));
        else {
          assert.deepEqual(result.failureScreenshot, { status: 'unavailable' });
          await assert.rejects(readFile(join(folder, situation, 'dashboard-failure.png')), { code: 'ENOENT' });
        }
      } else assert.equal(result.failureScreenshot, undefined);
    }
  } finally { delete globalThis[key]; await rm(folder, { recursive: true, force: true }); }
});
test('account priming performs only normal Settings navigation and obtains a new response pair on reopen', async () => {
  const page = new ScopePage(), observer = observeDashboardAccount(page, DASHBOARD_ORIGIN);
  const first = await observer.prime(options()), second = await observer.prime(options());
  assert.equal(first.settings.sequence, 2); assert.equal(second.settings.sequence, 4);
  assert.deepEqual(page.visits, [`${DASHBOARD_ORIGIN}/settings`, `${DASHBOARD_ORIGIN}/settings`]);
  assert.equal(page.calls, 2); await observer.dispose();
});
test('a newer failed Settings request cannot be overwritten by an older delayed body', async () => {
  const page = new ScopePage(), observer = observeDashboardAccount(page, DASHBOARD_ORIGIN); await observer.prime(options());
  let finish; const old = page.request('settings'); page.response(old, new Promise(resolve => { finish = resolve; }));
  const newest = page.request('settings'); assert.equal(observer.snapshot().settings, null);
  page.response(newest, {}, 503); finish({ doctor_id: 'doctor_' + id }); await tick();
  assert.equal(observer.snapshot().settings, null);
  await assert.rejects(observer.read(options()), /account_response_not_observed/); await observer.dispose();
});
test('newest active view-as response defeats a delayed old inactive response', async () => {
  const page = new ScopePage(), observer = observeDashboardAccount(page, DASHBOARD_ORIGIN); await observer.prime(options());
  let finish; page.response(page.request('view-as/status'), new Promise(resolve => { finish = resolve; }));
  page.response(page.request('view-as/status'), { ...inactive(), active: true, target: { doctor_id: 'doctor_other' } });
  finish(inactive()); await tick();
  assert.equal(observer.snapshot().viewAs.active, true);
  await assert.rejects(observer.read(options()), /dashboard_actor_scope/); await observer.dispose();
});
test('Clerk is read after delayed normal responses settle, so an intervening account change is rejected', async () => {
  const page = new ScopePage(), observer = observeDashboardAccount(page, DASHBOARD_ORIGIN); await observer.prime(options());
  let finish; page.response(page.request('settings'), new Promise(resolve => { finish = resolve; }));
  const reading = observer.read(options()); await tick(); assert.equal(page.calls, 1);
  page.userId = 'user_other'; finish({ doctor_id: 'doctor_' + id });
  await assert.rejects(reading, /dashboard_actor_scope/); assert.equal(page.calls, 2); await observer.dispose();
});
test('new request during final Clerk read forces a new check rather than using captured account cells', async () => {
  const page = new ScopePage(), observer = observeDashboardAccount(page, DASHBOARD_ORIGIN); await observer.prime(options());
  let finish; page.evaluate = async () => { page.evaluate = ScopePage.prototype.evaluate; return new Promise(resolve => { finish = resolve; }); };
  const reading = observer.read(options()); await tick();
  page.response(page.request('settings'), { doctor_id: 'doctor_01m5sf1cwwfwv9mk5fnx07cwr9' });
  finish({ userId: 'user_a', sessionId: 'session_a' });
  await assert.rejects(reading, /dashboard_actor_scope/); await observer.dispose();
});
test('reopen without fresh normal Settings/ViewAs replies cannot reuse earlier account proof', async () => {
  const page = new ScopePage(), observer = observeDashboardAccount(page, DASHBOARD_ORIGIN); await observer.prime(options());
  page.goto = async () => {};
  await assert.rejects(observer.prime(options()), /account_response_not_observed/); await observer.dispose();
});
test('navigation retires previous document cells before goto and ignores late previous replies', async () => {
  const page = new ScopePage(), observer = observeDashboardAccount(page, DASHBOARD_ORIGIN); await observer.prime(options());
  let finish; page.response(page.request('settings'), new Promise(resolve => { finish = resolve; }));
  page.goto = async () => {
    assert.deepEqual(observer.snapshot(), { settings: null, viewAs: null });
    finish({ doctor_id: 'doctor_' + id });
  };
  await assert.rejects(observer.prime(options()), /account_response_not_observed/);
  assert.deepEqual(observer.snapshot(), { settings: null, viewAs: null }); await observer.dispose();
});
