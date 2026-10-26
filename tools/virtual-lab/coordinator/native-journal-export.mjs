import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyBuild } from './native-identity.mjs';
import { sha256 } from './journal.mjs';

const exec = promisify(execFile), exports = new WeakSet();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail = code => Error(`native_journal_${code}`);
const metadata = value => ({ dev: String(value.dev), ino: String(value.ino), size: String(value.size),
  mtimeNs: String(value.mtimeNs), uid: String(value.uid), mode: String(value.mode) });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const freeze = value => { if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
  for (const child of Object.values(value)) freeze(child); Object.freeze(value);
} return value; };

export function validateIOSJournalPath(container, udid) {
  const prefix = `/CoreSimulator/Devices/${udid}/data/Containers/Data/Application/`;
  const pieces = typeof container === 'string' ? container.split(prefix) : [];
  if (typeof udid !== 'string' || !uuid(udid.toLowerCase()) || pieces.length !== 2 || !container.startsWith('/') || resolve(container) !== container
      || !uuid(pieces[1]?.toLowerCase()))
    throw fail('container_unconfirmed');
  return join(container, 'Library/Caches/scribe-capture-startup-v1.json');
}

/** One bounded, stable read of the fixed metadata journal; no product request.
 * Atomic replacement during the read is refused, never treated as a new copy. */
export async function readStableNativeJournal(path, { allowMissing = false } = {}) {
  let handle;
  try {
    if (await realpath(path) !== path) throw fail('path_changed');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 32768n || before.uid !== BigInt(process.getuid()) || (before.mode & 0o077n))
      throw fail('file_unconfirmed');
    const buffer = Buffer.alloc(32769);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat({ bigint: true }), named = await stat(path, { bigint: true });
    if (bytes.length !== Number(before.size) || !equal(metadata(before), metadata(after))
        || !equal(metadata(after), metadata(named)) || await realpath(path) !== path) throw fail('file_changed');
    return { status: 'READ', bytes, file: metadata(after), sha256: sha256(bytes) };
  } catch (error) {
    if (allowMissing && !handle && error.code === 'ENOENT') return { status: 'MISSING', bytes: null, file: null, sha256: null };
    throw error;
  } finally { await handle?.close(); }
}

async function currentHost(clockIdentity, signal) {
  if (process.platform !== 'darwin' || clockIdentity?.hostname !== hostname()
      || clockIdentity.parentPID !== process.pid || !uuid(clockIdentity.bootSessionUUID)) throw fail('clock_host_changed');
  const opts = { signal, timeout: 2000, maxBuffer: 16384 };
  const [boot, hardware] = await Promise.all([
    exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], opts),
    exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], opts),
  ]);
  const matches = [...hardware.stdout.matchAll(/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]+)"/g)];
  if (boot.stdout.trim().toLowerCase() !== clockIdentity.bootSessionUUID || matches.length !== 1
      || sha256(matches[0][1].toLowerCase()) !== clockIdentity.hardwareSHA256) throw fail('clock_host_changed');
}

async function currentProcess(expected, installed, signal) {
  if (!Number.isSafeInteger(expected?.pid) || expected.pid <= 1 || typeof expected.processStart !== 'string'
      || expected.executablePath !== installed.executablePath) throw fail('process_unconfirmed');
  const { stdout } = await exec('/bin/ps', ['-p', String(expected.pid), '-o', 'lstart=', '-o', 'comm=', '-o', 'uid='],
    { signal, timeout: 2000, maxBuffer: 4096 });
  const match = stdout.trim().match(/^(.{24})\s+(.+?)\s+(\d+)$/);
  if (!match || match[1] !== expected.processStart || match[2] !== expected.executablePath
      || Number(match[3]) !== process.getuid()) throw fail('process_changed');
  return { pid: expected.pid, processStart: match[1], executablePath: match[2], uid: Number(match[3]),
    executableSHA256: installed.executableSHA256 };
}

/** Bind a fixed journal to the actual installed owned simulator process on the
 * same kernel as the clock collector. It never opens another app-data file. */
export async function exportOwnedIOSNativeJournal({ config, scenario, expectedProcess, clockIdentity, runId, signal, allowMissing = false }) {
  if (config?.target?.role !== 'owned-ios-simulator' || !uuid(runId)
      || config.admissionBinding?.runId !== runId || scenario.admissionBinding?.runId !== runId) throw fail('simulator_required');
  signal?.throwIfAborted();
  // Full bundle verification is outside the measured click interval and the
  // source's separate two-second custody gate. It has its own bounded deadline.
  signal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  await currentHost(clockIdentity, signal);
  const buildBefore = await verifyBuild(config, scenario, { signal });
  const before = await currentProcess(expectedProcess, buildBefore.installedApplication, signal);
  const { stdout } = await exec('xcrun', ['simctl', 'get_app_container', config.target.udid, config.app.bundleId, 'data'],
    { signal, timeout: 5000, maxBuffer: 4096 });
  const container = stdout.trim(), path = validateIOSJournalPath(container, config.target.udid);
  const deviceRoot = buildBefore.installedApplication.installedPath.split('/data/Containers/Bundle/Application/')[0];
  if (!container.startsWith(deviceRoot + '/data/Containers/Data/Application/')) throw fail('container_changed');
  if (await realpath(container) !== container) throw fail('container_changed');
  const readStartedNs = process.hrtime.bigint().toString();
  const value = await readStableNativeJournal(path, { allowMissing });
  const readCompletedNs = process.hrtime.bigint().toString();
  const buildAfter = await verifyBuild(config, scenario, { signal });
  const after = await currentProcess(expectedProcess, buildAfter.installedApplication, signal);
  await currentHost(clockIdentity, signal);
  if (!equal(before, after) || !equal(buildBefore, buildAfter)) throw fail('owner_changed');
  signal.throwIfAborted();
  const result = Object.freeze({ source: 'owned-ios-native-journal-export', status: value.status,
    targetId: scenario.targetId, scenarioRunId: scenario.runId, runId, process: Object.freeze(before),
    hostname: clockIdentity.hostname, hardwareSHA256: clockIdentity.hardwareSHA256, bootSessionUUID: clockIdentity.bootSessionUUID,
    build: freeze(buildBefore), container, path, file: value.file && Object.freeze(value.file),
    readStartedNs, readCompletedNs, sha256: value.sha256, byteLength: value.bytes?.length ?? 0,
    bytes: value.bytes ? Buffer.from(value.bytes) : null,
    completeness: 'NOT_ESTABLISHED_RING_EVICTION_AND_WRITE_FAILURES_ARE_NOT_COUNTED' });
  exports.add(result); return result;
}

export function requireOwnedJournalExport(value) {
  if (!exports.has(value) || value.bytes && sha256(value.bytes) !== value.sha256) throw fail('export_unconfirmed');
  return value;
}
