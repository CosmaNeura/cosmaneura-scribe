import { performance } from 'node:perf_hooks';
import { createParticipant, createCaptureProofGate } from '../zoom/participant-session.mjs';
import { BOT_PROOF_MAX_AGE_MS } from '../zoom/bot-capture-proof.mjs';
import { openFixtureRegistry } from '../zoom/fixture.mjs';
import { createMicrophoneSource } from './microphone-source.mjs';

const now = () => performance.timeOrigin + performance.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Provisional source-graph bound, declared before execution. The detector uses a
// 16 ms analyser window and 10 ms polling; clock RTT must be <= 50 ms. This is
// not a capture/Zoom transport synchronization allowance or a clinical SLA.
export const SOURCE_GRAPH_ONSET_TOLERANCE_MS = 100;
export const BOT_MONITOR_INTERVAL_MS = 1000;
export const BOT_SUPERVISION_WATCHDOG_MS = BOT_MONITOR_INTERVAL_MS + BOT_PROOF_MAX_AGE_MS;
const MAX_CLOCK_ROUND_TRIP_MS = 50, ANALYSIS_FRAMES = 256, SIGNAL_RMS = 0.005;
const check = signal => { if (signal.aborted) throw Error('source_aborted'); };
const clone = value => structuredClone(value);

/** Expected first detector-threshold crossing, including silence and the rolling
 * analyser window. This is computed from the same hash-validated PCM supplied to
 * the browser, starting at the actual scheduled source offset (also on resume). */
export function expectedSignalOffsetMs(fixture, offsetSeconds) {
  if (fixture.sampleRate !== 16000 || !Number.isFinite(offsetSeconds) || offsetSeconds < 0
      || offsetSeconds >= fixture.frames / fixture.sampleRate) throw Error('invalid_source_offset');
  const pcm = Buffer.from(fixture.base64, 'base64');
  if (pcm.length !== fixture.frames * 2) throw Error('invalid_source_pcm');
  const start = Math.floor(offsetSeconds * fixture.sampleRate);
  let sum = 0;
  for (let frame = start; frame < fixture.frames; frame++) {
    const sample = pcm.readInt16LE(frame * 2) / 32768;
    sum += sample * sample;
    if (frame - start >= ANALYSIS_FRAMES) {
      const old = pcm.readInt16LE((frame - ANALYSIS_FRAMES) * 2) / 32768;
      sum -= old * old;
    }
    if (sum / ANALYSIS_FRAMES > SIGNAL_RMS * SIGNAL_RMS)
      return Math.max(0, (frame + 1 - offsetSeconds * fixture.sampleRate) / fixture.sampleRate * 1000);
  }
  throw Error('source_phase_has_no_signal');
}

/** Supervises owned browser participants. Injected test ports require explicit
 * mock execution and can never produce a live source receipt. */
export class SourceGroup {
  #captureProof;
  constructor(config, observeProduct, ports = {}) {
    this.config = config; this.observeProduct = observeProduct; this.participants = [];
    this.executionKind = config.executionKind ?? 'live';
    if (!['live', 'mock'].includes(this.executionKind)
        || Object.keys(ports).length && this.executionKind !== 'mock'
        || this.executionKind === 'mock' && (!ports.createParticipant || !ports.openFixtureRegistry)) throw Error('invalid_source_execution_kind');
    this.factory = ports.createParticipant ?? createParticipant; this.registry = ports.openFixtureRegistry ?? openFixtureRegistry;
    this.microphoneFactory = ports.createMicrophoneSource ?? createMicrophoneSource;
    this.mockMicrophonePort = typeof ports.createMicrophoneSource === 'function';
    this.#captureProof = clone(config.captureProof ?? { kind: 'native' });
    this.proofKind = createCaptureProofGate(this.#captureProof).kind;
    this.requireBotSourceScope();
    this.lifetime = new AbortController(); this.pending = new Set(); this.connected = false; this.closing = null;
    this.evidence = { executionKind: this.executionKind, timingScope: 'generated_source_graph_only', captureTiming: 'NOT_RUN',
      onsetToleranceMs: SOURCE_GRAPH_ONSET_TOLERANCE_MS, phases: [] };
    if (this.proofKind === 'zoom-bot') this.evidence.botMonitoring = {
      intervalMs: BOT_MONITOR_INTERVAL_MS, requestTimeoutMs: BOT_PROOF_MAX_AGE_MS,
      supervisionWatchdogMs: BOT_SUPERVISION_WATCHDOG_MS,
      scope: 'periodic_provider_observation_not_continuous_audio_proof', observations: [] };
  }
  requireBotSourceScope() {
    // The resident collector admits one in-flight request. Use one combined
    // fixture; parallel graphs and bot pause/resume require separate support.
    if (this.proofKind === 'zoom-bot' && (!Array.isArray(this.config.participants)
        || this.config.participants.length !== 1 || !['zoom', 'virtual-microphone'].includes(this.config.participants[0].kind ?? 'zoom')))
      throw Error('bot_source_requires_one_zoom_participant');
  }
  run(signal, operation) {
    if (!(signal instanceof AbortSignal)) return Promise.reject(Error('source_signal_required'));
    if (this.closing) return Promise.reject(Error('source_group_closed'));
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    const closeKnown = () => { for (const item of this.participants) this.closeParticipant(item).catch(() => {}); };
    combined.addEventListener('abort', closeKnown, { once: true });
    const pending = Promise.resolve().then(() => { check(combined); return operation(combined); });
    this.pending.add(pending);
    // Track the original promise until every operation it launched has settled.
    pending.then(() => {}, () => {}).finally(() => { this.pending.delete(pending); combined.removeEventListener('abort', closeKnown); });
    return pending;
  }
  async call(signal, operation) { check(signal); const result = await operation(signal); check(signal); return result; }
  async all(signal, operation) {
    const results = await Promise.allSettled(this.participants.map((item, index) => this.call(signal, () => operation(item, index))));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(result => result.value);
  }
  connect({ signal } = {}) {
    if (this.connecting || this.connected) return Promise.reject(Error('sources_already_connected'));
    this.connecting = this.run(signal, async active => {
      this.requireBotSourceScope();
      const registry = await this.call(active, () => this.registry(this.config.registry, { signal: active }));
      const sources = this.config.participants;
      if (!Array.isArray(sources) || sources.length < 1 || sources.length > 4
          || new Set(sources.map(s => s.persona)).size !== sources.length
          || sources.some(s => !['zoom', 'virtual-microphone'].includes(s.kind ?? 'zoom'))
          || sources.filter(s => s.kind === 'virtual-microphone').length > 1
          || sources.some(s => s.file === 'visit.wav') && sources.length !== 1) throw Error('ambiguous_source_mix');
      for (const source of sources) {
        const fixture = await this.call(active, () => registry.load({ caseId: source.caseId, file: source.file, signal: active }));
        check(active);
        // Register even a late-created browser before checking cancellation, so
        // cleanup cannot miss a participant returned after its initial snapshot.
        let participant;
        try {
          if (source.kind === 'virtual-microphone') {
            if (this.executionKind === 'mock' && !this.mockMicrophonePort) throw Error('mock_microphone_port_required');
            participant = await this.microphoneFactory({ fixture, output: source.output, target: this.config.target,
              observeProduct: this.observeProduct, resourceOwner: this.config.resourceOwner, signal: active,
              captureProof: clone(this.#captureProof), nativeZoomCustody: clone(source.nativeZoomCustody) });
          } else participant = await this.factory({ fixture, playwrightPath: this.config.playwrightPath,
            executionKind: this.executionKind, observeProduct: this.observeProduct, audioConnectedControl: source.audioConnectedControl,
            resourceOwner: this.config.resourceOwner, signal: active, captureProof: clone(this.#captureProof) });
        }
        catch (error) {
          if (typeof error.closeParticipant === 'function') this.participants.push({ participant: { close: error.closeParticipant },
            fixture, persona: source.persona, closed: false });
          throw error;
        }
        const item = { participant, fixture, persona: source.persona, kind: source.kind ?? 'zoom', closed: false };
        this.participants.push(item);
        if (active.aborted) { await this.closeParticipant(item); check(active); }
        if (source.kind === 'virtual-microphone') {
          const state = await this.call(active, () => participant.status({ signal: active }));
          if (state.media?.graphKind !== 'coreaudio-output' || state.media.output?.deviceUID !== source.output?.deviceUID
              || state.media.output?.running !== true || state.media.output?.transport !== 'virtual'
              || state.media.playing || state.media.rms > 0.00001 || state.media.fixtureSha256 !== fixture.sha256
              || state.media.renderedFrames < 256) throw Error('initial_virtual_microphone_silence_failed');
          continue;
        }
        const meetingUrl = process.env[source.meetingUrlEnv];
        if (!meetingUrl) throw Error('meeting_url_missing');
        await this.call(active, () => participant.navigate(meetingUrl, { signal: active }));
        for (const step of source.joinSteps) {
          if (step.action === 'click') await this.call(active, () => participant.click({ ...step, signal: active }));
          else if (step.action === 'fill') await this.call(active, () => participant.fill({ ...step, value: step.env ? process.env[step.env] : step.value, signal: active }));
          else throw Error('invalid_zoom_ui_action');
        }
        const frames = (await this.call(active, () => participant.frames({ signal: active })))
          .filter(f => f.media?.audioRequests > 0 && f.media.tracks.some(t => t.state === 'live'));
        if (frames.length !== 1) throw Error('ambiguous_active_audio_frame');
        await this.call(active, () => participant.select({ frameId: frames[0].frameId, signal: active }));
        const state = await this.call(active, () => participant.status({ signal: active }));
        if (state.media.playing || state.media.rms > 0.00001 || state.media.fixtureSha256 !== fixture.sha256) throw Error('initial_silence_or_fixture_failed');
      }
      this.connected = true;
    });
    return this.connecting;
  }
  async clocks(signal) {
    return this.all(signal, async ({ participant, persona }) => {
      const samples = [];
      for (let i = 0; i < 3; i++) samples.push(await this.call(signal, () => participant.clockSample({ signal })));
      for (const sample of samples) {
        if (![sample.roundTripMs, sample.sentAtEpochMs, sample.receivedAtEpochMs, sample.media?.observedAtEpochMs].every(Number.isFinite)
            || sample.roundTripMs < 0 || sample.receivedAtEpochMs < sample.sentAtEpochMs) throw Error('source_clock_invalid');
      }
      const best = samples.sort((a, b) => a.roundTripMs - b.roundTripMs)[0];
      if (best.roundTripMs > MAX_CLOCK_ROUND_TRIP_MS) throw Error('source_clock_uncertain');
      return { persona, roundTripMs: best.roundTripMs, sentAtEpochMs: best.sentAtEpochMs, receivedAtEpochMs: best.receivedAtEpochMs,
        browserObservedAtEpochMs: best.media.observedAtEpochMs,
        clockOffsetMs: best.media.observedAtEpochMs - (best.sentAtEpochMs + best.receivedAtEpochMs) / 2 };
    });
  }
  async schedulePhase(name, signal, offsets) {
    const clocks = await this.clocks(signal), commonStartAtEpochMs = now() + 2000;
    const phase = { name, commonStartAtEpochMs, status: 'PENDING', sources: [] };
    this.evidence.phases.push(phase);
    // Source-side observations are retained as each request settles, including a
    // partial scheduling failure. all() waits for every concurrent request.
    await this.all(signal, async ({ participant, fixture, persona }, index) => {
      const offset = offsets?.[index] ?? 0;
      const source = { persona, fixtureSHA256: fixture.sha256, clock: clocks[index],
        expectedFirstSignalOffsetMs: expectedSignalOffsetMs(fixture, offset), firstSignal: null };
      phase.sources[index] = source;
      const options = { fixtureSha256: fixture.sha256, startAtEpochMs: commonStartAtEpochMs + clocks[index].clockOffsetMs,
        restart: name === 'initial' };
      const scheduled = await this.call(signal, () => name === 'initial' ? participant.schedule(options, { signal }) : participant.resume(options, { signal }));
      if (scheduled.nativeZoomCustody) source.nativeZoomCustody = clone(scheduled.nativeZoomCustody);
      const clock = scheduled.media?.scheduledClock;
      source.scheduledClock = clone(clock);
      if (!clock || clock.sourceOffsetSeconds !== offset || clock.startAtEpochMs !== options.startAtEpochMs
          || ![clock.sampleEpochMs, clock.sampleContextSeconds, clock.startAtContextSeconds].every(Number.isFinite)) throw Error('source_schedule_mismatch');
      source.sourceOffsetSeconds = offset;
    });
    return phase;
  }
  async verifyBotRecording(signal) {
    const startedAtEpochMs = now(), deadline = AbortSignal.timeout(BOT_PROOF_MAX_AGE_MS);
    const active = AbortSignal.any([signal, deadline]);
    const request = Promise.resolve().then(() => {
      check(active);
      return this.participants[0].participant.verifyRecording({ signal: active });
    });
    // A producer may ignore cancellation. Keep its operation tracked even
    // after timeout; late completion cannot revive the closed source group.
    this.pending.add(request);
    request.then(() => {}, () => {}).finally(() => this.pending.delete(request));
    let aborted;
    const cancelled = new Promise((_, reject) => {
      aborted = () => reject(Error(deadline.aborted ? 'bot_monitor_timeout' : 'source_aborted'));
      active.addEventListener('abort', aborted, { once: true });
      if (active.aborted) aborted();
    });
    try {
      const value = await Promise.race([request, cancelled]);
      check(active);
      this.evidence.botMonitoring.observations.push({ startedAtEpochMs, completedAtEpochMs: now(),
        captureIdentity: value.captureIdentity, ...(value.nativeZoomCustody ? { nativeZoomCustody: clone(value.nativeZoomCustody) } : {}) });
    } catch (error) {
      this.evidence.botMonitoring.failure = { startedAtEpochMs, failedAtEpochMs: now(),
        reason: deadline.aborted ? 'timeout' : 'recording_observation_failed' };
      this.lifetime.abort(); // Immediately close owned source graphs, even if the read hangs.
      throw error;
    } finally { active.removeEventListener('abort', aborted); }
  }
  observePhase(phase, states) {
    states.forEach((state, index) => {
      const media = state.media, source = phase.sources[index], fixture = this.participants[index].fixture;
      const nativeOutput = this.participants[index].kind === 'virtual-microphone';
      const sourceActive = nativeOutput ? media?.graphKind === 'coreaudio-output' && media.output?.running === true
        && media.output.transport === 'virtual' && media.output.deviceUID === this.config.participants[index].output.deviceUID
        : media?.tracks?.some(t => t.state === 'live' && t.enabled);
      if (media?.fixtureSha256 !== fixture.sha256 || !sourceActive
          || !Number.isFinite(media.offsetSeconds) || media.offsetSeconds < 0 || media.offsetSeconds > fixture.frames / fixture.sampleRate
          || media.scheduledClock?.startAtEpochMs !== source.scheduledClock.startAtEpochMs) throw Error('source_lost');
      if (!source.firstSignal && media.firstSignal) {
        const first = media.firstSignal;
        if (![first.observedAtEpochMs, first.audioContextSeconds, first.sourceOffsetSeconds].every(Number.isFinite)
            || first.pollingIntervalMs !== (nativeOutput ? 0 : 10) || first.analysisFrames !== ANALYSIS_FRAMES
            || nativeOutput && (first.measurement !== 'coreaudio-render-callback' || !Number.isSafeInteger(first.callbackFrames)
              || first.callbackFrames < 1 || first.callbackFrames > 65536)
            || first.audioContextSeconds < source.scheduledClock.startAtContextSeconds) throw Error('source_signal_invalid');
        source.firstSignal = clone(first);
        source.firstSignalCoordinatorEpochMs = first.observedAtEpochMs - source.clock.clockOffsetMs;
        source.onsetErrorMs = source.firstSignalCoordinatorEpochMs - phase.commonStartAtEpochMs - source.expectedFirstSignalOffsetMs;
        source.measurementUncertaintyMs = first.pollingIntervalMs + (ANALYSIS_FRAMES + (nativeOutput ? first.callbackFrames : 0))
          / fixture.sampleRate * 1000 + source.clock.roundTripMs / 2 + 1000 / fixture.sampleRate;
      }
    });
  }
  finishPhase(phase) {
    if (phase.sources.length !== this.participants.length || phase.sources.some(s => !s.firstSignal)) throw Error('source_signal_not_observed');
    const errors = phase.sources.map(s => s.onsetErrorMs);
    phase.onsetSkewMs = Math.max(...errors) - Math.min(...errors);
    phase.maximumAbsoluteOnsetErrorMs = Math.max(...errors.map(Math.abs));
    phase.status = phase.onsetSkewMs <= SOURCE_GRAPH_ONSET_TOLERANCE_MS
      && phase.maximumAbsoluteOnsetErrorMs <= SOURCE_GRAPH_ONSET_TOLERANCE_MS ? 'PASS' : 'FAIL';
    if (phase.status !== 'PASS') throw Error('source_onset_tolerance_exceeded');
  }
  play({ signal, pause, resume, quietWindow } = {}) {
    if (!this.connected || this.playing) return Promise.reject(Error('sources_not_ready'));
    this.playing = this.run(signal, async active => {
      if (this.proofKind === 'zoom-bot' && (quietWindow || pause || resume)) throw Error('bot_pause_resume_not_supported');
      if (quietWindow && (!Array.isArray(quietWindow) || quietWindow.length !== 2 || !quietWindow.every(Number.isFinite)
          || quietWindow[0] <= 0 || quietWindow[1] <= quietWindow[0] || typeof pause !== 'function' || typeof resume !== 'function'
          || this.participants.some(p => quietWindow[1] >= p.fixture.frames / p.fixture.sampleRate))) throw Error('invalid_quiet_window');
      let watchdog;
      const armWatchdog = () => {
        if (this.proofKind !== 'zoom-bot') return;
        clearTimeout(watchdog);
        const startedAtEpochMs = now();
        watchdog = setTimeout(() => {
          this.evidence.botMonitoring.failure ??= { startedAtEpochMs, failedAtEpochMs: now(), reason: 'supervision_watchdog' };
          this.lifetime.abort();
        }, BOT_SUPERVISION_WATCHDOG_MS);
      };
      // A hung browser status/scheduling call must not suspend supervision.
      // Only a completed fresh proof extends this independent source watchdog.
      armWatchdog();
      try {
      let phase = await this.schedulePhase('initial', active), paused = false, states, lastBotRead = -Infinity;
      const deadline = performance.now() + Math.max(...this.participants.map(p => p.fixture.frames / p.fixture.sampleRate * 1000)) + 90000;
      while (performance.now() < deadline) {
        if (this.proofKind === 'zoom-bot' && performance.now() - lastBotRead >= BOT_MONITOR_INTERVAL_MS) {
          await this.verifyBotRecording(active); lastBotRead = performance.now(); armWatchdog();
        }
        states = await this.all(active, ({ participant }) => participant.status({ signal: active }));
        this.observePhase(phase, states);
        if (quietWindow && !paused && states.every(s => s.media.offsetSeconds >= quietWindow[0])) {
          const stopped = await this.all(active, ({ participant }) => participant.pause({ signal: active }));
          this.observePhase(phase, stopped);
          this.evidence.pause = stopped.map((state, i) => ({ persona: this.participants[i].persona, media: clone(state.media) }));
          if (stopped.some(s => s.media.playing || s.media.completed || s.media.offsetSeconds < quietWindow[0] || s.media.offsetSeconds > quietWindow[1])) throw Error('quiet_window_missed');
          this.finishPhase(phase);
          await this.call(active, () => pause({ signal: active }));
          await this.call(active, () => resume({ signal: active }));
          phase = await this.schedulePhase('resumed', active, stopped.map(s => s.media.offsetSeconds));
          paused = true;
          continue;
        }
        if (states.every(s => s.media.completed && !s.media.playing)) break;
        await this.call(active, () => delay(100));
      }
      if (!states?.every((s, i) => s.media.completed && !s.media.playing
          && s.media.offsetSeconds === this.participants[i].fixture.frames / this.participants[i].fixture.sampleRate)) throw Error('source_timeout');
      if (quietWindow && !paused) throw Error('quiet_window_missed');
      this.finishPhase(phase);
      const measurements = this.participants.map(({ persona, fixture }, index) => ({ persona, fixtureSHA256: fixture.sha256,
        framesCompleted: Math.round(states[index].media.offsetSeconds * fixture.sampleRate), pausePerformed: paused,
        phases: this.evidence.phases.map(p => ({ name: p.name, commonStartAtEpochMs: p.commonStartAtEpochMs,
          onsetSkewMs: p.onsetSkewMs, maximumAbsoluteOnsetErrorMs: p.maximumAbsoluteOnsetErrorMs, status: p.status,
          ...clone(p.sources[index]) })) }));
      return { executionKind: this.executionKind, sourceState: 'ended', measurements, ...clone(this.evidence) };
      } catch (error) {
        if (this.proofKind === 'zoom-bot') this.lifetime.abort();
        throw error;
      } finally { clearTimeout(watchdog); }
    });
    return this.playing;
  }
  closeParticipant(item) {
    if (item.closed) return Promise.resolve();
    if (item.closing) return item.closing;
    item.closing = Promise.resolve().then(() => item.participant.close()).then(receipt => {
      item.closeReceipt = receipt;
      if (receipt?.ownedResourcesSettled !== true) throw Error('source_cleanup_unconfirmed');
      item.closed = true;
    })
      .finally(() => { item.closing = null; });
    return item.closing;
  }
  cleanup() {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.closing = (async () => {
      // Closing current browsers interrupts pending UI waits. Await setup/play as
      // well, then close participants which their in-flight creation returned late.
      await Promise.allSettled([...this.pending, ...this.participants.map(item => this.closeParticipant(item))]);
      await Promise.allSettled(this.participants.map(item => this.closeParticipant(item)));
      return { syntheticParticipantsClosed: this.participants.every(item => item.closed), sourceOperationsSettled: true,
        ownedResourcesSettled: this.participants.every(item => item.closed),
        participantResources: this.participants.map(item => ({ persona: item.persona, closeReceipt: item.closeReceipt })),
        nativeAppTerminated: false, sourceEvidence: clone(this.evidence) };
    })();
    return this.closing;
  }
}
