import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {syntheticMedia} from './synthetic-media.mjs';
import {requireValidatedFixture} from './fixture.mjs';
import {prepareParticipantOwner} from './resource-owner.mjs';
import {BotCaptureProofGate} from './bot-capture-proof.mjs';

const now = () => performance.timeOrigin + performance.now();
const domains = ['zoom.us', 'zoom.com'];
export function checkMeetingUrl(value, executionKind) {
  const url = new URL(value);
  const zoom = url.protocol === 'https:' && domains.some(d => url.hostname === d || url.hostname.endsWith('.' + d));
  const local = executionKind === 'loopback' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || !zoom && !local) throw Error('meeting-origin');
  return url.href;
}
export function validateProductObservation(observation, state, epochMs = now()) {
  if (observation?.scope !== 'product-ui' || !observation.targetId || !observation.sessionId
      || !Number.isFinite(observation.observedAtEpochMs) || observation.observedAtEpochMs > epochMs + 50
      || epochMs - observation.observedAtEpochMs > 2000 || observation.capture?.sessionId !== observation.sessionId) throw Error('product-observation-invalid');
  if (state === 'recording' && (observation.capture.state !== 'recording' || observation.capture.nativeState !== 'recording'
      || !(observation.capture.elapsedSeconds >= 0) || observation.consent?.sessionId !== observation.sessionId
      || observation.consent.state !== 'granted')) throw Error('recording-consent-required');
  if (state === 'idle' && !['saved', 'finished', 'idle'].includes(observation.capture.state)) throw Error('idle-required');
  return observation;
}

/** The default native contract is unchanged. Bot evidence requires an explicit
 * caller-selected branch and its own pinned occurrence/collector identity. */
export function createCaptureProofGate(proof = {kind: 'native'}) {
  if (proof?.kind === 'native' && Object.keys(proof).length === 1) return {
    kind: 'native', validate: (value, state, {now: epochMs = now()} = {}) => {
      if (value?.kind !== undefined && value.kind !== 'native') throw Error('capture-proof-kind-mismatch');
      return validateProductObservation(value, state, epochMs);
    },
    identity: value => value.sessionId,
  };
  if (proof?.kind !== 'zoom-bot' || Object.keys(proof).length !== 2 || !Object.hasOwn(proof, 'expected')) throw Error('capture-proof-kind-invalid');
  const gate = new BotCaptureProofGate(proof.expected);
  return {kind: 'zoom-bot', validate: (value, state, options) => gate.validate(value, state === 'idle' ? 'stopped' : state, options),
    identity: () => gate.captureIdentity, observationFailed: () => gate.observationFailed()};
}

/** An isolated owned participant. Rejoining a process starts silent. The caller
 * persists its identity and handles reattachment; no stale page/frame IDs survive. */
export async function createParticipant({fixture, playwrightPath, executionKind = 'live', observeProduct,
  audioConnectedControl, headless = true, resourceOwner, signal, captureProof}) {
  if (!['live', 'loopback'].includes(executionKind)) throw Error('execution-kind');
  if (typeof observeProduct !== 'function') throw Error('product-observer-required');
  if (executionKind === 'live' && !(signal instanceof AbortSignal)) throw Error('participant_signal_required');
  signal?.throwIfAborted();
  requireValidatedFixture(fixture);
  const proofGate = createCaptureProofGate(captureProof);
  if (executionKind === 'live' && !resourceOwner) throw Error('participant_resource_owner_required');
  const owner = resourceOwner ? await prepareParticipantOwner(resourceOwner, fixture.sha256) : null;
  let browser, server, ownerReceipt;
  const closeBrowser = async () => {
    try { await browser?.close(); } finally { await server?.close(); }
    if (owner) ownerReceipt = await owner.settled();
    return { ownedResourcesSettled: true, resourceOwner: ownerReceipt };
  };
  try {
  signal?.throwIfAborted();
  const {chromium} = await import(playwrightPath ? pathToFileURL(playwrightPath).href : 'playwright');
  signal?.throwIfAborted();
  const options = {headless, args: ['--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio', ...(owner ? [owner.argument] : [])]};
  if (owner) {
    server = await chromium.launchServer(options);
    ownerReceipt = await owner.launched(server.process());
    signal?.throwIfAborted();
    browser = await chromium.connect(server.wsEndpoint());
  } else browser = await chromium.launch(options);
  signal?.throwIfAborted();
  const context = await browser.newContext({permissions: ['microphone', 'camera'], viewport: {width: 1100, height: 800}});
  await context.addInitScript(syntheticMedia, fixture);
  let page = await context.newPage(), frame = page.mainFrame(), closed = false, closing = null, boundCaptureIdentity = null;
  signal?.throwIfAborted();
  const pageIds = new Map(), frameIds = new Map(); let sequence = 0;
  const id = (map, value) => { if (!map.has(value)) map.set(value, String(++sequence)); return map.get(value); };
  const frameState = async f => f.evaluate(() => window.__scribeSyntheticMedia?.report() ?? null);
  async function requireSilentDocuments() {
    for (const p of context.pages()) for (const f of p.frames()) {
      if ((await frameState(f).catch(() => null))?.playing) throw Error('source-playing');
    }
  }
  async function status() {
    if (closed || page.isClosed() || frame.isDetached()) throw Error('participant-detached');
    return {executionKind, pageId: id(pageIds, page), frameId: id(frameIds, frame), media: await frameState(frame), resourceOwner: ownerReceipt};
  }
  async function observe(state, signal) {
    const request = proofGate.kind === 'zoom-bot' ? {requestNonce: randomUUID(), sentAtEpochMs: now()} : null;
    let observation;
    try { observation = await observeProduct(request ? {kind: 'zoom-bot', requestNonce: request.requestNonce, ...(signal ? {signal} : {})} : undefined); }
    catch (error) { if (request) proofGate.observationFailed(); throw error; }
    if (request) request.receivedAtEpochMs = now();
    proofGate.validate(observation, state, {request, now: now()});
    const identity = proofGate.identity(observation);
    if (state === 'recording' && boundCaptureIdentity !== null && identity !== boundCaptureIdentity) throw Error('session-changed');
    return {observation, request};
  }
  async function schedule(options) {
    await requireSilentDocuments();
    const {observation, request} = await observe('recording');
    const before = await status();
    if (!before.media || before.media.fixtureSha256 !== options.fixtureSha256) throw Error('fixture-changed');
    if (before.media.audioRequests < 1 || !before.media.tracks.some(t => t.state === 'live' && t.enabled)) throw Error('no-requested-audio-stream');
    if (executionKind === 'live') {
      checkMeetingUrl(frame.url(), executionKind);
      if (!audioConnectedControl?.role || !audioConnectedControl.name) throw Error('audio-control-required');
      if (!await frame.getByRole(audioConnectedControl.role, {name: audioConnectedControl.name, exact: true}).isVisible()) throw Error('zoom-audio-not-connected');
    }
    proofGate.validate(observation, 'recording', {request, now: now()});
    boundCaptureIdentity = proofGate.identity(observation);
    const media = await frame.evaluate(value => window.__scribeSyntheticMedia.schedule(value), options);
    return {...before, media, observation};
  }
  return Object.freeze({
    executionKind,
    async navigate(url) { await requireSilentDocuments(); await page.goto(checkMeetingUrl(url, executionKind), {waitUntil: 'domcontentloaded', timeout: 45_000}); frame = page.mainFrame(); return status(); },
    async pages() { return Promise.all(context.pages().map(async p => ({pageId: id(pageIds, p), selected: p === page, closed: p.isClosed(), title: await p.title().catch(() => '')}))); },
    async frames() { return Promise.all(page.frames().map(async f => ({frameId: id(frameIds, f), selected: f === frame, media: await frameState(f).catch(() => null)}))); },
    async select({pageId, frameId}) {
      await requireSilentDocuments();
      if (pageId) { const candidate = [...pageIds].find(([, n]) => n === pageId)?.[0]; if (!candidate || candidate.isClosed()) throw Error('page-missing'); page = candidate; frame = page.mainFrame(); }
      if (frameId) { const candidate = [...frameIds].find(([, n]) => n === frameId)?.[0]; if (!candidate || !page.frames().includes(candidate) || candidate.isDetached()) throw Error('frame-missing'); frame = candidate; }
      return status();
    },
    snapshot: () => frame.locator('body').ariaSnapshot({timeout: 10_000}),
    readText: ({role, name}) => frame.getByRole(role, {name, exact: true}).textContent({timeout: 10_000}),
    click: ({role, name}) => frame.getByRole(role, {name, exact: true}).click({timeout: 10_000}),
    fill: ({label, value}) => frame.getByLabel(label, {exact: true}).fill(value, {timeout: 10_000}),
    status,
    async verifyRecording({signal} = {}) {
      if (proofGate.kind !== 'zoom-bot' || boundCaptureIdentity === null) throw Error('bot_recording_not_admitted');
      signal?.throwIfAborted();
      await observe('recording', signal);
      signal?.throwIfAborted();
      return {captureIdentity: boundCaptureIdentity};
    },
    async clockSample() { const sentAtEpochMs = now(), value = await status(), receivedAtEpochMs = now(); return {sentAtEpochMs, receivedAtEpochMs, roundTripMs: receivedAtEpochMs - sentAtEpochMs, ...value}; },
    schedule,
    async resume({startAtEpochMs = now() + 1000} = {}) { return schedule({fixtureSha256: fixture.sha256, startAtEpochMs, restart: false}); },
    async pause() { const media = await frame.evaluate(() => window.__scribeSyntheticMedia.pause()); return {...await status(), media}; },
    async load(next) {
      if (proofGate.kind === 'zoom-bot') throw Error('bot_fixture_reload_requires_new_participant');
      requireValidatedFixture(next);
      const {observation} = await observe('idle');
      const before = await status();
      if (before.media.playing) throw Error('source-playing');
      const media = await frame.evaluate(value => window.__scribeSyntheticMedia.load(value), next);
      fixture = next; boundCaptureIdentity = null;
      return {...before, media, observation};
    },
    async close() {
      if (closed) return;
      if (closing) return closing;
      closing = (async () => {
        // Browser close must still run if a page/context disappears while the
        // synthetic graphs stop. Failed browser close remains retryable.
        try {
          for (const p of context.pages()) for (const f of p.frames()) await f.evaluate(() => window.__scribeSyntheticMedia?.close()).catch(() => {});
        } finally { const receipt = await closeBrowser(); closed = true; return receipt; }
      })();
      try { return await closing; } finally { closing = null; }
    },
  });
  } catch (error) {
    try { await closeBrowser(); }
    catch (cleanupError) {
      // Return ownership to the coordinator even when initialization never
      // produced a participant. It can retry cleanup and retain its target lease.
      throw Object.assign(Error('participant_initialization_cleanup_failed', {cause: error}),
        {closeParticipant: closeBrowser, cleanupError});
    }
    throw error;
  }
}
