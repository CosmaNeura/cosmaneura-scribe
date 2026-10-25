import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runZoomBot, validateZoomConfig, collectZoomHost, ZOOM_BUDGETS } from './zoom-bot.mjs';
import { sha256 } from './journal.mjs';
import { projectAuthorization, projectBotNote, projectHostObservation, projectSchedule,
  validateAuthorizationScope, validateHostObservation } from './zoom-bot-evidence.mjs';
import { LatestReply, normalHostedScope, readZoomIdentity, requestPolicy } from './zoom-bot-ui.mjs';

const typed = (prefix, digit = '0') => `${prefix}_${digit.repeat(26)}`;
const authorization = () => ({ meetingId: '12345678901', meetingRecordRef: typed('zmtg'), appointmentRef: typed('appointment'),
  allowedAppointmentRefs: [typed('appointment')], allowedPatientRefs: [typed('patient')] });
const signal = () => new AbortController().signal;
async function fixture(action = 'profile') {
  const root = await mkdtemp(resolve(tmpdir(), 'zoom-run-test-'));
  const storageState = resolve(root, 'storage.json'); await writeFile(storageState, '{}', { mode: 0o600 });
  const config = { schema: 1, syntheticOnly: true, executionKind: 'mock', runId: randomUUID(), account: 'A', identitySHA256: sha256('synthetic A'),
    doctorRef: typed('doctor'), hostId: randomUUID().replaceAll('-', ''), action, apiOrigin: 'https://staging-app.cosmaneura.com',
    storageState, storageStateSHA256: sha256('{}'), playwrightPath: '/private/mock-playwright.mjs',
    collector: { executable: '/private/mock-python', executableSHA256: 'a'.repeat(64), script: '/private/mock.py', scriptSHA256: 'b'.repeat(64) },
    ...ZOOM_BUDGETS, ...(action === 'authorize' ? { authorization: authorization() } : {}) };
  const configPath = resolve(root, 'config.json'), output = resolve(root, 'run');
  await writeFile(configPath, JSON.stringify(config)); return { root, config, configPath, output };
}
function hostValue(config, request, connected = false) {
  const now = Date.now();
  return { source: 'live-staging-zoom-bot-observation', executionKind: 'live', status: 'READONLY_VERIFIED', runId: config.runId,
    requestNonce: request.requestNonce, observedAtEpochMs: now, scope: { hostIdSHA256: sha256(config.hostId), doctorRef: config.doctorRef },
    profile: { doctorRef: config.doctorRef, clerkSubjectSHA256: config.identitySHA256, emailSHA256: sha256('synthetic@example.com'), practiceRef: typed('practice'), deletedAt: null },
    hostBinding: { count: connected ? 1 : 0, ownerDoctorSHA256s: connected ? [sha256(config.doctorRef)] : [], matchingRequestedOwnerCount: connected ? 1 : 0 },
    requestedAccountIntegration: { count: connected ? 1 : 0, providerUserIdSHA256s: connected ? [sha256(config.hostId)] : [] },
    deployment: { sourceSHA: 'a'.repeat(40), webRevision: 'web-1', workerRevision: 'worker-1', imageDigest: `sha256:${'c'.repeat(64)}` },
    collector: { startedAtEpochMs: now, completedAtEpochMs: now, scriptSHA256: config.collector.scriptSHA256, querySHA256: 'd'.repeat(64) },
    ...(config.authorization ? { appointmentScope: { doctorRef: config.doctorRef,
      appointmentRefsSHA256s: [sha256(config.authorization.appointmentRef)], patientRefsSHA256s: [sha256(typed('patient'))],
      requestedAppointment: { appointmentRef: config.authorization.appointmentRef, doctorRef: config.doctorRef,
        patientRefSHA256: sha256(typed('patient')), scribeCaptureBindingCount: 0 },
      meeting: { meetingRecordRef: config.authorization.meetingRecordRef, meetingIdSHA256: sha256(config.authorization.meetingId),
        doctorRef: config.doctorRef, linkedAppointmentRef: null, status: 'scheduled' },
      appointmentLinkedMeetingCount: 0, captureAuthorizedMeetingCount: 0, linkedMeetingRecordRefsSHA256s: [] } } : {}) };
}
function portsFor(config, options = {}) {
  let connected = options.connected ?? config.action === 'authorize', enabled = false;
  const calls = { connect: 0, authorize: 0, close: 0, inspect: 0 };
  const profile = () => ({ source: 'normal-hosted-zoom-profile', executionKind: 'mock', identitySHA256: config.identitySHA256,
    sessionSHA256: sha256('session'), observedAtEpochMs: Date.now(), actor: { active: false, targetPresent: false, doctorRef: config.doctorRef },
    settings: { connected, noteSchemaCount: options.schemaCount ?? 1, noteSchemaIds: [typed('doctor_note_schema')] }, visible: { connectCount: connected ? 0 : 1, connectedCount: connected ? 1 : 0 } });
  return { calls,
    inspect: async () => { calls.inspect++; },
    collect: async (_, request) => hostValue(config, request, connected),
    open: async () => ({
      profile: async () => profile(),
      connect: async () => { calls.connect++; if (options.checkpoint) return { status: 'OAUTH_CHECKPOINT' }; connected = true; return { status: 'OAUTH_RETURNED' }; },
      schedule: async () => ({ ...profile(), meeting: { captureAuthorized: enabled, appointmentRef: enabled ? config.authorization.appointmentRef : null,
        meetingRecordRef: config.authorization.meetingRecordRef, meetingIdSHA256: sha256(config.authorization.meetingId), status: options.started ? 'started' : 'scheduled' } }),
      authorize: async () => { calls.authorize++; enabled = true; if (options.failAuthorize) throw Error('zoom_test_lost_reply'); return { status: 200,
        authorization: { appointmentRef: config.authorization.appointmentRef, state: 'pending' } }; },
      observations: async () => ({ responses: [], blocked: [] }),
      close: async () => { calls.close++; return { ownedResourcesSettled: options.settled !== false }; },
    }),
  };
}
test('configuration requires exact staging scope, private normal state and bounded budgets', async () => {
  const { config } = await fixture('authorize'); assert.equal(validateZoomConfig(config), config);
  for (const change of [{ apiOrigin: 'https://app.cosmaneura.com' }, { identitySHA256: 'REPLACE_ME' }, { oauthTimeoutMs: 900000 },
    { authorization: { ...config.authorization, appointmentRef: 'invented' } }, { hostId: '' }, { action: 'capture' }])
    assert.throws(() => validateZoomConfig({ ...config, ...change }));
});
test('normal request boundary denies broad lists, wrong origin and all unrequested mutations', async () => {
  const { config } = await fixture('authorize'), boundary = { config, action: 'authorize', listsAllowed: false, postUsed: false }, origin = config.apiOrigin;
  for (const path of ['/internal/v1/notes', '/internal/v1/patients', '/notes', '/notes/foreign', '/internal/v1/schedule/other/authorize-capture'])
    assert.equal(requestPolicy(origin + path, 'GET', null, boundary), false);
  assert.equal(requestPolicy(origin + '/internal/v1/schedule', 'GET', null, boundary), true);
  assert.equal(requestPolicy('https://production.example/internal/v1/settings', 'GET', null, boundary), false);
  const url = `${origin}/internal/v1/schedule/${config.authorization.meetingId}/authorize-capture`, body = JSON.stringify({ appointment_id: config.authorization.appointmentRef });
  assert.equal(requestPolicy(url, 'POST', body, boundary), false);
  boundary.listsAllowed = true; assert.equal(requestPolicy(url, 'POST', body, boundary), true);
  assert.equal(requestPolicy(url, 'POST', JSON.stringify({ appointment_id: config.authorization.appointmentRef, extra: 1 }), boundary), false);
  boundary.postUsed = true; assert.equal(requestPolicy(url, 'POST', body, boundary), false);
  assert.equal(requestPolicy(origin + '/internal/v1/zoom-connect', 'DELETE', null, boundary), false);
});
test('latest replies invalidate immediately and ignore late prior actor responses', () => {
  const cell = new LatestReply(), first = cell.begin(); cell.finish(first, { active: false });
  const next = cell.begin(); assert.equal(cell.value, null); cell.finish(first, { active: false }); assert.equal(cell.value, null);
  cell.finish(next, { active: true }); assert.deepEqual(cell.value, { active: true });
});
test('actual ordinary provider contract uses Settings doctor with explicit inactive null view-as actor', () => {
  const now = Date.now(), doctor = typed('doctor'), settings = { doctorRef: doctor, observedAtEpochMs: now },
    view = { observedAtEpochMs: now, actor: { active: false, targetPresent: false, doctorRef: null, canViewAs: false, readOnly: false, requestBinding: 'inactive' } };
  assert.equal(normalHostedScope(settings, view, doctor).doctorSource, 'normal-settings-response');
  for (const patch of [{ canViewAs: true }, { active: true }, { readOnly: true }, { targetPresent: true }, { requestBinding: 'other' }, { doctorRef: typed('doctor', '1') }])
    assert.throws(() => normalHostedScope(settings, { ...view, actor: { ...view.actor, ...patch } }, doctor));
  assert.throws(() => normalHostedScope({ ...settings, doctorRef: typed('doctor', '1') }, view, doctor));
  assert.throws(() => normalHostedScope({ ...settings, observedAtEpochMs: now - 16000 }, view, doctor));
});
test('collector requires fresh nonce, exact Clerk/doctor/host ownership and deployment evidence', async () => {
  const { config } = await fixture(), request = { requestNonce: randomUUID(), createdAtEpochMs: Date.now() }, value = hostValue(config, request);
  assert.equal(validateHostObservation(value, config, request).bindingState, 'UNBOUND');
  for (const mutate of [v => { v.requestNonce = 'stale'; }, v => { v.observedAtEpochMs -= 130000; }, v => { v.profile.clerkSubjectSHA256 = 'f'.repeat(64); },
    v => { v.hostBinding.count = 1; v.hostBinding.ownerDoctorSHA256s = [sha256('foreign')]; },
    v => { v.requestedAccountIntegration.count = 1; v.requestedAccountIntegration.providerUserIdSHA256s = [sha256('foreign')]; },
    v => { delete v.deployment; }, v => { v.collector.scriptSHA256 = 'f'.repeat(64); }]) {
    const candidate = structuredClone(value); mutate(candidate); assert.throws(() => validateHostObservation(candidate, config, request));
  }
});
test('authorization inventory refuses unknown patients, native captures, reused meetings and foreign tuples', async () => {
  const { config } = await fixture('authorize'), request = { requestNonce: randomUUID(), createdAtEpochMs: Date.now() }, value = hostValue(config, request, true);
  assert.ok(validateAuthorizationScope(value, config.authorization));
  for (const mutate of [v => v.patientRefsSHA256s.push(sha256('unknown')),
    v => { v.requestedAppointment.scribeCaptureBindingCount = 1; }, v => { v.meeting.linkedAppointmentRef = typed('appointment', '1'); },
    v => { v.appointmentLinkedMeetingCount = 1; v.linkedMeetingRecordRefsSHA256s = [sha256('othermeeting')]; },
    v => { v.requestedAppointment.doctorRef = typed('doctor', '1'); }]) {
    const candidate = structuredClone(value); mutate(candidate.appointmentScope); assert.throws(() => validateAuthorizationScope(candidate, config.authorization));
  }
});
test('projections omit topics, bearer URLs, provider tokens and arbitrary payloads', async () => {
  const { config } = await fixture('authorize'), req = { requestNonce: randomUUID() }, value = hostValue(config, req, true);
  value.token = 'SECRET'; value.profile.token = 'SECRET'; value.appointmentScope.requestedAppointment.name = 'NAME';
  assert.equal(JSON.stringify(projectHostObservation(value)).includes('SECRET'), false);
  assert.equal(JSON.stringify(projectHostObservation(value)).includes('NAME'), false);
  const row = { id: config.authorization.meetingRecordRef, zoom_meeting_id: config.authorization.meetingId,
    appointment_id: null, capture_authorized: false, status: 'scheduled', topic: 'PRIVATE', join_url: 'SECRET' };
  const data = { zoom_connected: true, capture_available: true, meetings: [row] };
  assert.equal(JSON.stringify(projectSchedule(data, config.authorization)).includes('SECRET'), false);
  assert.throws(() => projectSchedule({ ...data, meetings: [row, row] }, config.authorization));
  assert.throws(() => projectAuthorization({ appointment_id: typed('appointment', '1'), state: 'pending' }, config.authorization));
});
test('dedicated bot note tuple binds exact transcript and never introduces a native session', () => {
  const expected = { doctorRef: typed('doctor'), appointmentRef: typed('appointment'), transcriptRef: typed('ai_visit_transcript') };
  const transcript = { id: expected.transcriptRef, appointment_id: expected.appointmentRef, doctor_id: expected.doctorRef,
    patient_id: typed('patient'), transcript_data: [{ content: 'synthetic', startTime: 0, endTime: 1000 }] };
  const data = { appointment: { id: expected.appointmentRef, doctor_id: expected.doctorRef, patient_id: typed('patient') },
    notes: [{ id: typed('visit_note'), ai_transcript_id: transcript.id, appointment_id: expected.appointmentRef, doctor_id: expected.doctorRef, note: { History: 'synthetic' } }],
    note_transcripts: [transcript] };
  assert.equal(projectBotNote(data, expected).aiTranscriptRef, transcript.id);
  assert.equal('nativeSessionId' in projectBotNote(data, expected), false);
  assert.throws(() => projectBotNote({ ...data, capture_workflow_required: true }, expected));
  assert.throws(() => projectBotNote({ ...data, notes: [{ ...data.notes[0], ai_transcript_id: 'foreign' }] }, expected));
});
test('profile doctor performs observations, closes owned UI, and never qualifies bot acceptance', async () => {
  const fixtureData = await fixture(), ports = portsFor(fixtureData.config);
  const state = await runZoomBot({ ...fixtureData, command: 'doctor', signal: signal(), ports });
  assert.equal(state.status, 'MOCK_PROFILE_OBSERVED'); assert.equal(state.fullAcceptance, 'NOT_RUN');
  assert.equal(state.botMedia, 'NOT_RUN'); assert.equal(state.manualSave, 'NOT_AVAILABLE');
  assert.equal(ports.calls.connect, 0); assert.equal(ports.calls.close, 1); assert.equal(state.guardRetained, false);
});
test('OAuth checkpoint resume reconciles without a repeated Connect click', async () => {
  const data = await fixture('connect'), ports = portsFor(data.config, { checkpoint: true });
  const state = await runZoomBot({ ...data, signal: signal(), ports });
  assert.equal(state.status, 'OAUTH_CHECKPOINT'); assert.equal(ports.calls.connect, 1);
  const resumed = await runZoomBot({ ...data, command: 'resume', signal: signal(), ports });
  assert.equal(resumed.status, 'OAUTH_CHECKPOINT'); assert.equal(ports.calls.connect, 1);
  const completed = await runZoomBot({ ...data, command: 'resume', signal: signal(), ports: portsFor(data.config, { connected: true }) });
  assert.equal(completed.status, 'CONNECTED_OBSERVED'); assert.equal(completed.pending, null);
});
test('Connect refreshes normal browser scope after a collector exceeds the unchanged 15s limit', async () => {
  const data = await fixture('connect'), ports = portsFor(data.config), collect = ports.collect, open = ports.open;
  let injectedTime = 100000, lastProfile = 0;
  const clock = () => injectedTime;
  ports.collect = async (...args) => { injectedTime += 16001; return collect(...args); };
  ports.open = async (...args) => {
    const ui = await open(...args), profile = ui.profile, connect = ui.connect;
    ui.profile = async () => { const result = await profile(); lastProfile = clock(); return result; };
    ui.connect = async () => { assert.ok(clock() - lastProfile <= 15000, 'normal browser scope has expired'); return connect(); };
    return ui;
  };
  const state = await runZoomBot({ ...data, signal: signal(), ports });
  assert.equal(state.status, 'CONNECTED_OBSERVED'); assert.equal(ports.calls.connect, 1);
});

test('final Zoom Clerk read follows settled responses and rejects an intervening identity change', async () => {
  const settings = new LatestReply(), viewAs = new LatestReply(), doctor = typed('doctor'), config = { doctorRef: doctor, identitySHA256: sha256('user_a'), uiTimeoutMs: 1000 };
  let release, reads = 0, user = 'user_a'; const clock = () => 1000;
  const waiting = new Promise(resolve => { release = () => {
    settings.finish(settings.begin(), { doctorRef: doctor, observedAtEpochMs: clock() });
    viewAs.finish(viewAs.begin(), { observedAtEpochMs: clock(), actor: { active: false, targetPresent: false, doctorRef: null,
      canViewAs: false, readOnly: false, requestBinding: 'inactive' } }); resolve();
  }; });
  const page = { waitForFunction: async () => {}, evaluate: async () => { reads++; return { user, session: 'session_a' }; } };
  const result = readZoomIdentity({ page, settings, viewAs, work: new Set([waiting]), config, signal: signal(), clock });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 0);
  user = 'user_b'; release(); await assert.rejects(result, /zoom_hosted_actor_mismatch/); assert.equal(reads, 1);
});
test('a new Zoom view-as request during the final Clerk read invalidates the captured generation', async () => {
  const settings = new LatestReply(), viewAs = new LatestReply(), doctor = typed('doctor'), config = { doctorRef: doctor, identitySHA256: sha256('user_a'), uiTimeoutMs: 1000 };
  settings.finish(settings.begin(), { doctorRef: doctor, observedAtEpochMs: 1000 });
  const inactive = { observedAtEpochMs: 1000, actor: { active: false, targetPresent: false, doctorRef: null,
    canViewAs: false, readOnly: false, requestBinding: 'inactive' } };
  viewAs.finish(viewAs.begin(), inactive);
  let release, reads = 0;
  const page = { waitForFunction: async () => {}, evaluate: async () => {
    reads++; return reads === 1 ? new Promise(resolve => { release = resolve; }) : { user: 'user_a', session: 'session_a' };
  } };
  const result = readZoomIdentity({ page, settings, viewAs, work: new Set(), config, signal: signal(), clock: () => 1000 });
  await new Promise(resolve => setImmediate(resolve));
  viewAs.finish(viewAs.begin(), { ...inactive, actor: { ...inactive.actor, active: true } });
  release({ user: 'user_a', session: 'session_a' });
  await assert.rejects(result, /zoom_hosted_actor_mismatch/); assert.equal(reads, 2);
});
test('lost authorization reply never repeats POST on resume', async () => {
  const data = await fixture('authorize'), ports = portsFor(data.config, { failAuthorize: true });
  const failed = await runZoomBot({ ...data, signal: signal(), ports });
  assert.equal(failed.status, 'FAIL'); assert.equal(failed.pending.action, 'authorize'); assert.equal(ports.calls.authorize, 1);
  const state = await runZoomBot({ ...data, command: 'resume', signal: signal(), ports });
  assert.equal(state.status, 'AUTHORIZATION_OBSERVED'); assert.equal(ports.calls.authorize, 1);
});
test('unknown authorization after a lost reply is a checkpoint and never retried', async () => {
  const data = await fixture('authorize');
  await runZoomBot({ ...data, signal: signal(), ports: portsFor(data.config, { failAuthorize: true }) });
  const ports = portsFor(data.config), state = await runZoomBot({ ...data, command: 'resume', signal: signal(), ports });
  assert.equal(state.status, 'AUTHORIZATION_UNCERTAIN'); assert.equal(ports.calls.authorize, 0);
});
test('already-started meeting cannot be armed by the profile-only slice', async () => {
  const data = await fixture('authorize'), ports = portsFor(data.config, { started: true });
  const state = await runZoomBot({ ...data, signal: signal(), ports });
  assert.equal(state.failureCode, 'zoom_not_started_authorization_required'); assert.equal(ports.calls.authorize, 0);
});
test('missing active note schema blocks the bot authorization prerequisite', async () => {
  const data = await fixture('authorize'), ports = portsFor(data.config, { schemaCount: 0 });
  const state = await runZoomBot({ ...data, signal: signal(), ports });
  assert.equal(state.failureCode, 'zoom_note_schema_setup_required'); assert.equal(ports.calls.authorize, 0);
});
test('resume refuses changed configuration or edited observation bytes before opening UI', async () => {
  const data = await fixture(), ports = portsFor(data.config);
  const state = await runZoomBot({ ...data, signal: signal(), ports });
  await writeFile(resolve(data.output, state.observations[0].file), '{}');
  const nextPorts = portsFor(data.config), resumed = await runZoomBot({ ...data, command: 'resume', signal: signal(), ports: nextPorts });
  assert.equal(resumed.failureCode, 'zoom_pinned_input_changed'); assert.equal(nextPorts.calls.inspect, 0);
  await writeFile(data.configPath, JSON.stringify({ ...data.config, account: 'B' }));
  await assert.rejects(runZoomBot({ ...data, command: 'resume', signal: signal(), ports }), /zoom_resume_identity_changed/);
});
test('live configs reject mock adapters and nonprivate normal cookie stores', async () => {
  const data = await fixture(); data.config.executionKind = 'live'; await writeFile(data.configPath, JSON.stringify(data.config));
  await assert.rejects(runZoomBot({ ...data, signal: signal(), ports: portsFor(data.config) }), /zoom_mock_ports_forbidden/);
  await chmod(data.config.storageState, 0o644);
  await assert.rejects(runZoomBot({ ...data, signal: signal() }), /zoom_pinned_input_changed/);
});
test('uncertain owned browser cleanup retains guard instead of claiming settlement', async () => {
  const data = await fixture(), state = await runZoomBot({ ...data, signal: signal(), ports: portsFor(data.config, { settled: false }) });
  assert.equal(state.guardRetained, true); assert.equal(state.cleanup.ownedResourcesSettled, false);
});
test('real collector subprocess is hash-pinned, bounded and uses only structured stdin', async () => {
  const data = await fixture(), script = resolve(data.root, 'collector.mjs'), executable = await import('node:fs/promises').then(fs => fs.realpath(process.execPath));
  await writeFile(script, "let text=''; for await(const c of process.stdin) text+=c; process.stdout.write(JSON.stringify({request:JSON.parse(text)}));\n");
  data.config.collector = { executable, executableSHA256: sha256(await readFile(executable)), script, scriptSHA256: sha256(await readFile(script)) };
  assert.deepEqual(await collectZoomHost(data.config, { requestNonce: 'only metadata' }, signal()), { request: { requestNonce: 'only metadata' } });
  await writeFile(script, 'throw Error("changed")');
  await assert.rejects(collectZoomHost(data.config, {}, signal()), /zoom_pinned_input_changed/);
});
test('actual child crash leaves a bound journal and same-run dead guard can resume', async () => {
  const data = await fixture(), script = resolve(data.root, 'crash.mjs');
  await writeFile(script, `import {runZoomBot} from ${JSON.stringify(new URL('./zoom-bot.mjs', import.meta.url).href)};
await runZoomBot({configPath:${JSON.stringify(data.configPath)},output:${JSON.stringify(data.output)},signal:new AbortController().signal,
ports:{inspect:async()=>{},open:async()=>{process.exit(29)}}});\n`);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' }); const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 29);
  const before = JSON.parse(await readFile(resolve(data.output, 'zoom-run.json'))); assert.equal(before.runIdentity.runId, data.config.runId);
  const resumed = await runZoomBot({ ...data, command: 'resume', signal: signal(), ports: portsFor(data.config) });
  assert.equal(resumed.status, 'MOCK_PROFILE_OBSERVED'); assert.equal(resumed.guardRetained, false);
});
