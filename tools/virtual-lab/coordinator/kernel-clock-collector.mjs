import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { projectKernelClockSample, boundKernelClockWindow, supportedKernelClockRuntime } from './kernel-clock.mjs';

const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail = code => Error(`kernel_clock_${code}`);
const MAX_REPLY = 8192, MAX_NS = 2_000_000_000n;
// Prospectively reviewed engineering budgets, not user-agreed SLAs. This module does not alter engine budgets
// or declare UI/native attribution from a clock-only result.
export const NATIVE_PERFORMANCE_BUDGETS_NS = Object.freeze({ cold_launch: '10000000000', warm_launch: '4000000000',
  workspace: '4000000000', preparation: '7000000000', record: '4000000000', resume: '4000000000' });

/** One owned child's pipe, one outstanding nonce, no replay. Protocol failure
 * poisons future measurements but still permits bounded child-only cleanup. */
export class KernelClockPipe {
  constructor(child, { runId, identity, signal, nodeVersion = process.versions.node, uvVersion = process.versions.uv }) {
    if (!uuid(runId) || child.pid !== identity?.pid || identity.parentPID !== process.pid) throw fail('child_identity_invalid');
    this.child = child; this.runId = runId; this.identity = structuredClone(identity);
    this.nodeVersion = nodeVersion; this.uvVersion = uvVersion; this.sequence = 0;
    this.buffer = Buffer.alloc(0); this.pending = null; this.failure = null; this.records = []; this.closing = null;
    this.closed = false;
    this.exit = new Promise(resolve => child.once('close', (code, signal) => {
      this.closed = true; this.exitReceipt = { code, signal };
      if (!this.closing) this.poison('child_closed');
      resolve(this.exitReceipt);
    }));
    child.on('error', () => this.poison('child_error'));
    child.stdin.on('error', () => this.poison('pipe_error'));
    child.stdout.on('error', () => this.poison('pipe_error'));
    child.stderr?.on('data', () => this.poison('unexpected_stderr'));
    child.stdout.on('data', bytes => this.receive(bytes));
    this.lifetimeSignal = signal;
    this.lifetimeAbort = () => { this.poison('collector_aborted'); void this.close().catch(() => {}); };
    signal?.addEventListener('abort', this.lifetimeAbort, { once: true });
    if (signal?.aborted) this.lifetimeAbort();
  }
  poison(code) {
    this.failure ??= fail(code);
    const pending = this.pending; this.pending = null;
    pending?.reject(this.failure);
  }
  receive(bytes) {
    if (this.failure) return;
    if (!this.pending || this.buffer.length + bytes.length > MAX_REPLY) { this.poison('unexpected_output'); return; }
    this.buffer = Buffer.concat([this.buffer, bytes]);
    const end = this.buffer.indexOf(10);
    if (end < 0) return;
    // The helper cannot legally produce another response until another request.
    // Reject even a partial extra line instead of carrying it into that request.
    if (end !== this.buffer.length - 1) { this.poison('extra_output'); return; }
    const pending = this.pending, received = process.hrtime.bigint();
    try {
      if (received > pending.deadline) throw fail('request_deadline');
      const reply = JSON.parse(this.buffer.subarray(0, end).toString('utf8'));
      const raw = { reply, nodeSentNs: pending.sent.toString(), nodeReceivedNs: received.toString(),
        expectedNonce: pending.nonce, expectedRunId: this.runId, expectedIdentity: this.identity,
        nodeVersion: this.nodeVersion, uvVersion: this.uvVersion };
      const projected = projectKernelClockSample(raw);
      if (reply.sequence !== this.sequence) throw fail('sequence_changed');
      this.buffer = Buffer.alloc(0); this.pending = null;
      this.records.push({ raw: structuredClone(raw), projected }); pending.resolve(projected);
    } catch { this.poison('reply_invalid'); }
  }
  async sample({ signal, deadlineNs = process.hrtime.bigint() + MAX_NS } = {}) {
    signal?.throwIfAborted();
    if (this.failure || this.closed || this.closing) throw this.failure ?? fail('closed');
    if (this.pending) throw fail('concurrent_request');
    const now = process.hrtime.bigint();
    if (typeof deadlineNs !== 'bigint' || deadlineNs <= now || deadlineNs - now > MAX_NS) throw fail('request_deadline');
    if (this.sequence >= 64) throw fail('request_limit');
    const nonce = randomUUID(); this.sequence++;
    let timer, abort;
    try {
      const value = await new Promise((resolve, reject) => {
        // Clock stamp directly precedes pipe dispatch, not a cached reply read.
        const sent = process.hrtime.bigint(), deadline = deadlineNs < sent + MAX_NS ? deadlineNs : sent + MAX_NS;
        this.pending = { nonce, sent, deadline, resolve, reject };
        abort = () => this.poison('request_aborted');
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => this.poison('request_deadline'), Math.max(1, Number(deadline - sent) / 1e6));
        this.child.stdin.write(JSON.stringify({ operation: 'sample', nonce }) + '\n', error => {
          if (error) this.poison('pipe_error');
        });
      });
      signal?.throwIfAborted();
      if (this.failure) throw this.failure;
      return value;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  snapshot() {
    return { source: 'owned-kernel-clock-collection', runId: this.runId, identity: structuredClone(this.identity),
      sampleCount: this.records.length, samples: this.records.map(value => structuredClone(value.raw)),
      failure: this.failure?.message ?? null, qualification: 'NOT_ESTABLISHED',
      nativeSessionAttribution: 'REQUIRES_OWNED_PROCESS_JOURNAL_PROOF', browserPrecision: 'UNKNOWN', acousticArrival: 'NOT_MEASURED' };
  }
  window(before, after) {
    if (this.failure || !this.records.some(value => value.projected === before) || !this.records.some(value => value.projected === after))
      throw fail('collection_unqualified');
    return boundKernelClockWindow(before, after);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.pending) this.poison('collection_closed');
      this.child.stdin.end();
      for (const signal of [null, 'SIGTERM', 'SIGKILL']) {
        if (this.closed) break;
        if (signal && this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
        let timer;
        try { await Promise.race([this.exit, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
        finally { clearTimeout(timer); }
      }
      this.lifetimeSignal?.removeEventListener('abort', this.lifetimeAbort);
      if (!this.closed) throw fail('child_unsettled');
      return { ownedResourcesSettled: true, childExit: this.exitReceipt, nativeAppTerminated: false };
    })();
    return this.closing;
  }
}

/** Starts only the hash-pinned read-only helper below the owned target root.
 * This does not acquire UI ownership, inspect native content, or launch an app. */
export async function createKernelClockCollector({ executable, executableSHA256, target, runId, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'darwin' || !supportedKernelClockRuntime(process.versions.node, process.versions.uv)
      || !uuid(runId) || target?.hostname !== hostname()
      || !['owned-ios-simulator', 'owned-macos-lab', 'owned-macos-guest'].includes(target.role)
      || !/^[a-f0-9]{64}$/.test(executableSHA256 ?? '')) throw fail('target_invalid');
  const root = await realpath(target.root), markerPath = await realpath(target.marker), path = await realpath(executable);
  for (const value of [markerPath, path]) {
    const rel = relative(root, value);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw fail('path_outside_target');
  }
  if (path !== executable) throw fail('helper_symlink');
  const markerStat = await lstat(markerPath);
  if (!markerStat.isFile() || markerStat.size > 16384) throw fail('marker_invalid');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.purpose !== 'scribe-synthetic-virtual-lab' || marker.hostname !== target.hostname || marker.role !== target.role
      || target.role === 'owned-ios-simulator' && marker.udid !== target.udid) throw fail('marker_changed');
  const verify = async () => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000000 || hash(await readFile(path)) !== executableSHA256) throw fail('helper_changed');
  };
  await verify();
  const [boot, hardware] = await Promise.all([
    exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 2000, maxBuffer: 256 }),
    exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 2000, maxBuffer: 16384 }),
  ]).catch(() => { throw fail('host_identity_unavailable'); });
  const bootSessionUUID = boot.stdout.trim().toLowerCase(), matches = [...hardware.stdout.matchAll(/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]+)"/g)];
  if (!uuid(bootSessionUUID) || matches.length !== 1 || !uuid(matches[0][1].toLowerCase())) throw fail('host_identity_unavailable');
  const hardwareSHA256 = hash(matches[0][1].toLowerCase());
  if (hardwareSHA256 !== target.hardwareSHA256) throw fail('hardware_changed');
  signal?.throwIfAborted();
  const child = spawn(path, [`--scribe-virtual-lab-owner=${runId}`], { cwd: root, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let pipe;
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fail('child_spawn_failed'))); });
    pipe = new KernelClockPipe(child, { runId, signal, identity: { hostname: target.hostname, hardwareSHA256, bootSessionUUID,
      pid: child.pid, parentPID: process.pid } });
    await verify();
    const row = await exec('/bin/ps', ['-p', String(child.pid), '-o', 'lstart=', '-o', 'comm='], { timeout: 2000, maxBuffer: 4096 });
    const match = row.stdout.trim().match(/^(.{24})\s+(.+)$/);
    if (!match || match[2] !== path) throw fail('helper_process_changed');
    const launchReceipt = Object.freeze({ source: 'owned-kernel-clock-helper', executable: path, executableSHA256,
      pid: child.pid, parentPID: process.pid, processStart: match[1], hostname: target.hostname, hardwareSHA256, bootSessionUUID });
    signal?.throwIfAborted();
    return Object.freeze({ launchReceipt, sample: options => pipe.sample(options), snapshot: () => pipe.snapshot(),
      window: (before, after) => pipe.window(before, after), close: () => pipe.close() });
  } catch (error) {
    if (pipe) await pipe.close();
    else if (child.pid) child.kill('SIGTERM');
    throw error;
  }
}
