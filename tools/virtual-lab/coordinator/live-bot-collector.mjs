import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {performance} from 'node:perf_hooks';
import {BotCaptureProofGate, BOT_PROOF_MAX_AGE_MS} from '../zoom/bot-capture-proof.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, code) => { if (!condition) throw Error(`live_bot_${code}`); };
const keys = (value, list) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === list.length && list.every(key => Object.hasOwn(value, key));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const now = () => performance.timeOrigin + performance.now();
const MAX_FRAME = 262144, MAX_CONFIG = 16384, MAX_READY_MS = 90000;

async function pinnedFile(path, expected, {privateFile = false, max = 4000000} = {}) {
  need(isAbsolute(path ?? '') && digest(expected), 'file_pin_required');
  const stat = await lstat(path);
  need(stat.isFile() && !stat.isSymbolicLink() && (stat.uid === process.getuid() || !privateFile && stat.uid === 0)
    && stat.size > 0 && stat.size <= max && (!privateFile || (stat.mode & 0o077) === 0)
    && await realpath(path) === path, 'file_scope_changed');
  const bytes = await readFile(path);
  need(hash(bytes) === expected, 'file_bytes_changed');
  return bytes;
}

/** A real normal host UI action record, with every named screenshot/tree byte
 * verified. The caller supplies evidence after performing that UI action. No
 * verified boolean, inferred consent, or screenshot-content claim is accepted.
 * The independent action record remains reviewable beside the projected DTO. */
export async function readNormalHostArtifact(binding, expected, kind) {
  need(keys(binding, ['path', 'sha256', 'files']) && ['consent', 'end'].includes(kind)
    && Array.isArray(binding.files) && binding.files.length >= 1 && binding.files.length <= 4, 'host_artifact_binding_invalid');
  const bytes = await pinnedFile(binding.path, binding.sha256, {privateFile: true, max: 16384});
  const value = JSON.parse(bytes);
  const fields = kind === 'consent'
    ? ['source', 'action', 'actionId', 'hostIdSHA256', 'meetingIdSHA256', 'occurrenceDigest', 'observedAtEpochMs', 'files']
    : ['source', 'action', 'actionId', 'hostIdSHA256', 'meetingIdSHA256', 'occurrenceDigest', 'actionStartedAtEpochMs', 'observedAtEpochMs', 'files'];
  need(keys(value, fields) && value.source === (kind === 'consent' ? 'normal-zoom-host-consent-ui' : 'normal-zoom-host-end-ui')
    && value.action === (kind === 'consent' ? 'approve_recording' : 'end_meeting_for_all') && uuid(value.actionId)
    && ['hostIdSHA256', 'meetingIdSHA256', 'occurrenceDigest'].every(key => value[key] === expected[key])
    && Number.isFinite(value.observedAtEpochMs) && value.observedAtEpochMs >= expected.startedAtEpochMs
    && value.observedAtEpochMs <= now() + 50
    && (kind === 'consent' || Number.isFinite(value.actionStartedAtEpochMs)
      && value.actionStartedAtEpochMs >= expected.startedAtEpochMs && value.actionStartedAtEpochMs <= value.observedAtEpochMs)
    && Array.isArray(value.files) && value.files.length === binding.files.length, 'normal_host_action_missing');
  for (const [index, pin] of binding.files.entries()) {
    need(keys(pin, ['path', 'sha256']) && keys(value.files[index], ['sha256'])
      && value.files[index].sha256 === pin.sha256, 'host_artifact_file_mismatch');
    await pinnedFile(pin.path, pin.sha256, {privateFile: true});
  }
  const {files: _files, ...metadata} = value;
  return {...metadata, artifactSHA256: binding.sha256};
}

/** One owned, already established private transport. Unknown output poisons
 * recording; no cached response, unsolicited line, nonce reuse or in-flight
 * overlap is accepted. Stop reads remain possible after a settled read refusal.
 */
export class LiveBotPipe {
  constructor(child, {expected, deployment, signal}) {
    need(child.pid > 0 && child.stdin && child.stdout && signal instanceof AbortSignal, 'owned_pipe_required');
    this.child = child; this.expected = structuredClone(expected); this.deployment = structuredClone(deployment);
    this.gate = new BotCaptureProofGate(expected); this.signal = signal;
    this.buffer = Buffer.alloc(0); this.pending = null; this.ready = false; this.failure = null;
    this.closed = false; this.closing = null; this.used = new Set(); this.recordingBlocked = false;
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.exit = new Promise(resolve => child.once('close', (code, signal) => {
      this.closed = true; this.exitReceipt = {code, signal}; this.poison('owned_transport_closed'); resolve(this.exitReceipt);
    }));
    child.on('error', () => this.poison('owned_transport_failed'));
    child.stdin.on('error', () => this.poison('private_pipe_failed'));
    child.stdout.on('error', () => this.poison('private_pipe_failed'));
    child.stderr?.on('data', () => this.poison('unexpected_stderr'));
    child.stdout.on('data', bytes => this.receive(bytes));
    this.abort = () => { this.poison('aborted'); void this.close(); };
    signal.addEventListener('abort', this.abort, {once: true});
    if (signal.aborted) this.abort();
  }
  poison(code) {
    this.failure ??= Error(`live_bot_${code}`); this.recordingBlocked = true; this.gate.observationFailed();
    this.readyReject(this.failure);
    const pending = this.pending; this.pending = null; pending?.reject(this.failure);
  }
  receive(bytes) {
    if (this.failure) return;
    if ((!this.pending && this.ready) || this.buffer.length + bytes.length > MAX_FRAME) { this.poison('unexpected_output'); return; }
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const index = this.buffer.indexOf(10);
    if (index < 0) return;
    if (index !== this.buffer.length - 1) { this.poison('extra_output'); return; }
    try {
      const value = JSON.parse(this.buffer.subarray(0, index)); this.buffer = Buffer.alloc(0);
      if (!this.ready) {
        need(keys(value, ['version', 'kind', 'runId', 'collectorSHA256', 'revision', 'schema'])
          && value.version === 1 && value.kind === 'live-bot-reader-ready' && value.runId === this.expected.runId
          && value.collectorSHA256 === this.expected.collectorSHA256 && value.revision === this.deployment.revision
          && value.schema === this.deployment.schema, 'resident_reader_not_ready');
        this.ready = true; this.readyResolve(value); return;
      }
      const pending = this.pending, receivedAtEpochMs = now();
      need(pending && receivedAtEpochMs - pending.sentAtEpochMs <= BOT_PROOF_MAX_AGE_MS
        && value.version === 1 && value.runId === this.expected.runId && value.requestNonce === pending.nonce, 'nonce_or_deadline_changed');
      if (pending.action === 'close') {
        need(keys(value, ['version', 'runId', 'requestNonce', 'closed']) && value.closed === true, 'remote_close_unconfirmed');
        this.pending = null;
        pending.resolve({remoteReaderResourcesSettled: true}); return;
      }
      if (keys(value, ['version', 'runId', 'requestNonce', 'errorCode'])) {
        need(typeof value.errorCode === 'string' && /^[a-z_]{1,96}$/.test(value.errorCode), 'read_error_invalid');
        this.pending = null; this.recordingBlocked = true; this.gate.observationFailed(); pending.reject(Error('live_bot_read_unconfirmed')); return;
      }
      need(keys(value, ['version', 'runId', 'requestNonce', 'observation']), 'response_fields_invalid');
      this.pending = null;
      try {
        this.gate.validate(value.observation, pending.action === 'observe' ? 'recording' : 'stopped', {
          request: {requestNonce: pending.nonce, sentAtEpochMs: pending.sentAtEpochMs, receivedAtEpochMs}, now: receivedAtEpochMs});
        pending.resolve(value.observation);
      } catch (error) { this.recordingBlocked = true; pending.reject(error); }
    } catch { this.poison('response_invalid'); }
  }
  async initialize(config) {
    const raw = JSON.stringify(config) + '\n';
    need(Buffer.byteLength(raw) <= MAX_CONFIG, 'configuration_bound');
    this.child.stdin.write(raw);
    let timer;
    try { return await Promise.race([this.readyPromise, new Promise((_, reject) => {
      timer = setTimeout(() => { this.poison('startup_timeout'); reject(this.failure); }, MAX_READY_MS);
    })]); } finally { clearTimeout(timer); }
  }
  async request(action, requestNonce, consent, hostEnd) {
    this.signal.throwIfAborted();
    need(this.ready && !this.failure && !this.closed && (!this.closing || action === 'close') && !this.pending
      && uuid(requestNonce) && !this.used.has(requestNonce) && this.used.size < 4160
      && (action === 'observeStopped' || action === 'close' || !this.recordingBlocked), 'request_refused');
    this.used.add(requestNonce);
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        const sentAtEpochMs = now(); this.pending = {action, nonce: requestNonce, sentAtEpochMs, resolve, reject};
        timer = setTimeout(() => this.poison('request_timeout'), BOT_PROOF_MAX_AGE_MS);
        this.child.stdin.write(JSON.stringify({version: 1, runId: this.expected.runId, action, requestNonce, consent, hostEnd}) + '\n',
          error => { if (error) this.poison('private_pipe_failed'); });
      });
    } finally { clearTimeout(timer); }
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.pending) this.poison('collection_closed');
      let remoteReaderResourcesSettled = false;
      if (this.ready && !this.failure && !this.closed) {
        try { remoteReaderResourcesSettled = (await this.request('close', randomUUID(), null, null)).remoteReaderResourcesSettled === true; }
        catch { /* Keep the cleanup result unqualified; kill only the owned child below. */ }
      }
      this.child.stdin.end();
      for (const signal of [null, 'SIGTERM', 'SIGKILL']) {
        if (this.closed) break;
        if (signal && this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
        let timer;
        try { await Promise.race([this.exit, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
        finally { clearTimeout(timer); }
      }
      this.signal.removeEventListener('abort', this.abort);
      need(this.closed, 'owned_transport_unsettled');
      return {ownedResourcesSettled: remoteReaderResourcesSettled, ownedTransportClosed: true,
        remoteReaderResourcesSettled, childExit: this.exitReceipt, providerMutations: 0, recordMutations: 0};
    })();
    return this.closing;
  }
}

/** Launches only a pinned private-transport operator. Its reviewed selection
 * names one current ready staging replica; no general argv/URL is exposed.
 * The operator establishes the stream once and relays metadata frames only.
 */
export async function createLiveBotCollector({transport, expected, privateScope, deployment, consentArtifact, signal}) {
  need(keys(transport, ['executable', 'executableSHA256', 'script', 'scriptSHA256']) && signal instanceof AbortSignal,
    'transport_configuration_invalid');
  new BotCaptureProofGate(expected); signal.throwIfAborted();
  await pinnedFile(transport.executable, transport.executableSHA256, {max: 200000000});
  await pinnedFile(transport.script, transport.scriptSHA256, {privateFile: true, max: 131072});
  const consent = await readNormalHostArtifact(consentArtifact, expected, 'consent');
  const child = spawn(transport.executable, ['-I', '-B', transport.script], {
    stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
  });
  let pipe;
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(Error('live_bot_launch_failed'))); });
    pipe = new LiveBotPipe(child, {expected, deployment, signal});
    await pipe.initialize({version: 1, expected, privateScope, deployment});
    await pinnedFile(transport.script, transport.scriptSHA256, {privateFile: true, max: 131072});
    let end = null, endBinding = null;
    return Object.freeze({
      observe: async ({requestNonce}) => {
        try {
          const current = await readNormalHostArtifact(consentArtifact, expected, 'consent');
          need(JSON.stringify(current) === JSON.stringify(consent), 'consent_artifact_changed');
          return await pipe.request('observe', requestNonce, consent, null);
        } catch (error) {
          pipe.recordingBlocked = true; pipe.gate.observationFailed(); throw error;
        }
      },
      bindNormalEnd: async binding => {
        need(end === null, 'normal_end_already_bound'); end = await readNormalHostArtifact(binding, expected, 'end');
        endBinding = structuredClone(binding);
      },
      observeStopped: async ({requestNonce}) => {
        need(end !== null, 'normal_end_required');
        const current = await readNormalHostArtifact(endBinding, expected, 'end');
        need(JSON.stringify(current) === JSON.stringify(end), 'normal_end_artifact_changed');
        return pipe.request('observeStopped', requestNonce, consent, end);
      },
      close: () => pipe.close(),
      launchReceipt: {source: 'owned-resident-live-bot-reader', transportScriptSHA256: transport.scriptSHA256,
        collectorSHA256: expected.collectorSHA256, pid: child.pid, parentPID: process.pid,
        revision: deployment.revision, schema: deployment.schema, publicListener: false},
    });
  } catch (error) {
    if (pipe) await pipe.close(); else if (child.pid) child.kill('SIGTERM');
    throw error;
  }
}
