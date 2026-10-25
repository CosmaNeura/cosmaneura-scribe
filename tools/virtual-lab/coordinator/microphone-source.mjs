import { spawn } from 'node:child_process';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { hash, requireValidatedFixture } from '../zoom/fixture.mjs';
import { prepareParticipantOwner } from '../zoom/resource-owner.mjs';
import { validateProductObservation } from '../zoom/participant-session.mjs';

const now = () => performance.timeOrigin + performance.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = async (promise, ms, message) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
};
export function microphoneFixture(fixture) {
  requireValidatedFixture(fixture);
  return { base64: fixture.base64, frames: fixture.frames, sampleRate: fixture.sampleRate,
    fixtureSha256: fixture.sha256, consentRecordId: fixture.consentRecordId,
    pcmSHA256: hash(Buffer.from(fixture.base64, 'base64')) };
}
export function requireMicrophoneRecording(observation, boundSessionId = null) {
  validateProductObservation(observation, 'recording');
  if (boundSessionId && boundSessionId !== observation.sessionId) throw Error('microphone_session_changed');
  const native = observation.nativeObservation, epoch = native?.browserTimeOriginMs + native?.observedAtMonotonicMs;
  if (!native || native.sessionId !== observation.sessionId || native.phase !== 'recording'
      || !Number.isSafeInteger(native.nativeRevision) || native.nativeRevision < 0 || !Number.isFinite(epoch) || Math.abs(now() - epoch) > 15000
      || (native.source === 'normal-native-recording-response' ? native.busy !== false
        : native.source !== 'normal-desktop-recording-response' || native.pendingMutation !== false || native.captureState !== 'recording'))
    throw Error('microphone_native_recording_unconfirmed');
  return observation;
}
export async function verifyMicrophoneExecutable(output, target) {
  if (output?.deviceUID !== 'BlackHole2ch_UID' || !/^[a-f0-9]{64}$/.test(output?.sha256 ?? '')
      || !['owned-ios-simulator', 'owned-macos-lab', 'owned-macos-guest'].includes(target?.role)
      || target.hostname !== hostname()) throw Error('owned_virtual_microphone_required');
  const root = await realpath(target.root), markerPath = await realpath(target.marker), executable = await realpath(output.executable);
  for (const path of [markerPath, executable]) {
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('microphone_path_outside_owned_root');
  }
  const marker = JSON.parse(await readFile(markerPath));
  if (marker.purpose !== 'scribe-synthetic-virtual-lab' || marker.hostname !== target.hostname || marker.role !== target.role
      || target.role === 'owned-ios-simulator' && marker.udid !== target.udid) throw Error('microphone_target_marker_mismatch');
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.size > 64000000 || hash(await readFile(executable)) !== output.sha256) throw Error('microphone_helper_changed');
  return executable;
}

/** Fixed line protocol over this child's inherited pipes, never a saved PID/socket. */
export class MicrophoneChild {
  constructor(child) {
    this.child = child; this.pending = new Map(); this.closed = false; this.failure = null; this.buffer = '';
    this.exit = new Promise(resolve => child.once('exit', (code, signal) => {
      this.closed = true; this.exitReceipt = { code, signal }; this.fail(Error('microphone_child_exited')); resolve(this.exitReceipt);
    }));
    child.on('error', () => this.fail(Error('microphone_child_error')));
    child.stdin.on('error', () => this.fail(Error('microphone_pipe_error')));
    child.stdout.on('data', bytes => {
      this.buffer += bytes.toString('utf8');
      if (Buffer.byteLength(this.buffer) > 65536) { this.fail(Error('microphone_reply_too_large')); return; }
      for (;;) {
        const index = this.buffer.indexOf('\n'); if (index < 0) break;
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        try {
          const value = JSON.parse(line), pending = this.pending.get(value.id);
          if (!pending || value.ok !== true || !value.media || typeof value.media !== 'object') throw Error('microphone_reply_invalid');
          this.pending.delete(value.id); pending.resolve(value.media);
        } catch { this.fail(Error('microphone_reply_invalid')); }
      }
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  async request(command, fields = {}, { signal, timeoutMs = 10000, cleanup = false } = {}) {
    signal?.throwIfAborted();
    if (this.closed || this.failure && !cleanup || this.pending.size >= 8) throw this.failure ?? Error('microphone_child_unavailable');
    const id = randomUUID(), bytes = JSON.stringify({ id, command, ...fields }) + '\n';
    if (Buffer.byteLength(bytes) > 26100000) throw Error('microphone_command_too_large');
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(Error('microphone_command_aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    const reply = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(bytes, error => { if (error) this.fail(Error('microphone_pipe_error')); });
    });
    try { return await bounded(Promise.race([reply, aborted]), timeoutMs, 'microphone_command_timeout'); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async close() {
    if (!this.closed) {
      try { await this.request('close', {}, { timeoutMs: 2000, cleanup: true }); } catch { /* Still stop only this owned child. */ }
      this.child.stdin.end();
      for (const signal of [null, 'SIGTERM', 'SIGKILL']) {
        if (this.closed) break;
        if (signal && this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
        try { await bounded(this.exit, 2000, 'microphone_child_shutdown_timeout'); } catch { /* Retain uncertainty if still present. */ }
      }
    }
    if (!this.closed) throw Error('microphone_child_unsettled');
    return this.exitReceipt;
  }
}

export async function createMicrophoneSource({ fixture, output, target, resourceOwner, observeProduct, signal }) {
  if (!(signal instanceof AbortSignal) || typeof observeProduct !== 'function') throw Error('microphone_signal_and_observer_required');
  signal.throwIfAborted(); let payload = microphoneFixture(fixture);
  const executable = await verifyMicrophoneExecutable(output, target);
  const owner = await prepareParticipantOwner(resourceOwner, fixture.sha256, { kind: 'coreaudio-source', executableSHA256: output.sha256 });
  let protocol, ownerReceipt, boundSessionId = null, closing = null, closed = false;
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      const childExit = await protocol?.close();
      const resource = await owner.settled(); closed = true;
      return { ownedResourcesSettled: true, nativeAppTerminated: false, resourceOwner: resource, childExit };
    })();
    try { return await closing; } finally { if (!closed) closing = null; }
  };
  try {
    signal.throwIfAborted();
    const child = spawn(executable, [owner.argument], { stdio: ['pipe', 'pipe', 'ignore'], env: {}, cwd: target.root });
    protocol = new MicrophoneChild(child); ownerReceipt = await owner.launched(child);
    signal.throwIfAborted();
    const check = media => {
      if (media?.graphKind !== 'coreaudio-output' || media.fixtureSha256 !== fixture.sha256 || media.pcmSHA256 !== payload.pcmSHA256
          || media.output?.deviceUID !== output.deviceUID || media.output.transport !== 'virtual' || media.output.running !== true
          || !['silent', 'scheduled', 'playing', 'paused', 'ended'].includes(media.state)
          || !Number.isFinite(media.observedAtEpochMs) || Math.abs(now() - media.observedAtEpochMs) > 2000
          || !Number.isSafeInteger(media.renderedFrames) || media.renderedFrames < 0
          || !Number.isFinite(media.offsetSeconds) || media.offsetSeconds < 0 || media.offsetSeconds > fixture.frames / fixture.sampleRate)
        throw Error('microphone_output_not_observed');
      return { executionKind: 'live', sourceKind: 'virtual-microphone', media, resourceOwner: ownerReceipt };
    };
    check(await protocol.request('initialize', { deviceUID: output.deviceUID, fixture: payload }, { signal }));
    const status = async ({ signal: active = signal } = {}) => {
      if (closed) throw Error('microphone_source_closed');
      return check(await protocol.request('status', {}, { signal: active }));
    };
    let initial = await status();
    const readyDeadline = now() + 2000;
    while (initial.media.renderedFrames < 256 && now() < readyDeadline) { await delay(10); initial = await status(); }
    if (initial.media.renderedFrames < 256 || initial.media.playing || initial.media.rms !== 0 || initial.media.offsetSeconds !== 0) throw Error('microphone_initial_silence_failed');
    const schedule = async (options, { signal: active = signal } = {}) => {
      active.throwIfAborted();
      const observation = requireMicrophoneRecording(await observeProduct(active), boundSessionId);
      await status({ signal: active });
      requireMicrophoneRecording(observation, boundSessionId);
      if (options.fixtureSha256 !== fixture.sha256) throw Error('microphone_fixture_changed');
      boundSessionId = observation.sessionId;
      return { ...check(await protocol.request('schedule', options, { signal: active })), observation };
    };
    return Object.freeze({ sourceKind: 'virtual-microphone', status, schedule, close,
      async clockSample(options) { const sentAtEpochMs = now(), value = await status(options), receivedAtEpochMs = now();
        return { ...value, sentAtEpochMs, receivedAtEpochMs, roundTripMs: receivedAtEpochMs - sentAtEpochMs }; },
      resume: (options, context) => schedule({ ...options, fixtureSha256: fixture.sha256, restart: false }, context),
      async load(next, { signal: active = signal } = {}) {
        active.throwIfAborted();
        validateProductObservation(await observeProduct(active), 'idle');
        const before = await status({ signal: active });
        if (before.media.playing) throw Error('microphone_source_playing');
        const nextPayload = microphoneFixture(next);
        const media = await protocol.request('load', { fixture: nextPayload }, { signal: active });
        fixture = next; payload = nextPayload; boundSessionId = null;
        return check(media);
      },
      async pause({ signal: active = signal } = {}) {
        const value = check(await protocol.request('pause', {}, { signal: active }));
        if (value.media.playing || value.media.silentFrames < 256 || value.media.rms > 0.00001) throw Error('microphone_pause_silence_unconfirmed');
        return value;
      },
    });
  } catch (error) {
    try { await close(); } catch { throw Object.assign(Error('microphone_initialization_cleanup_failed', { cause: error }), { closeParticipant: close }); }
    throw error;
  }
}
