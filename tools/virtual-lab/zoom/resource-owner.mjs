import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { hash as sha256 } from './fixture.mjs';

const execute = promisify(execFile);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const markerFor = resourceId => `--scribe-virtual-lab-owner=${resourceId}`;
async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

/** Keep only owned matches from the actual process inventory, never unrelated
 * command lines or historical PID commands. Exported parser supports negatives. */
export function matchingParticipantProcesses(stdout, owner) {
  const rows = String(stdout).split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean).map(match => ({ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }));
  const owned = rows.filter(row => row.command.includes(markerFor(owner.resourceId))
    || owner.browser?.profile && row.command.includes(owner.browser.profile));
  for (let index = 0; index < owned.length; index++) {
    for (const row of rows) if (row.parentPid === owned[index].pid && !owned.includes(row)) owned.push(row);
  }
  return owned.map(({ pid, parentPid }) => ({ pid, parentPid }));
}
async function processInventory(signal) {
  signal?.throwIfAborted();
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,command='], { signal, timeout: 5000, maxBuffer: 8000000 });
  signal?.throwIfAborted(); return stdout;
}
async function ownerFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('participant_owner_file_invalid');
  const bytes = await readFile(path), owner = JSON.parse(bytes);
  if (owner.schema !== 1 || !uuid(owner.runId) || !uuid(owner.resourceId) || owner.host !== hostname()
      || !Number.isSafeInteger(owner.coordinatorPid) || owner.coordinatorPid < 1
      || ![undefined, 'browser', 'coreaudio-source'].includes(owner.kind)
      || !['launching', 'active', 'closed'].includes(owner.phase)) throw Error('participant_owner_identity_invalid');
  return { owner, sha256: sha256(bytes) };
}

export async function prepareParticipantOwner(config, fixtureSHA256, { kind = 'browser', executableSHA256 } = {}) {
  if (!uuid(config?.runId) || !isAbsolute(config?.ownedRoot ?? '') || !/^[a-f0-9]{64}$/.test(fixtureSHA256)) throw Error('participant_resource_owner_required');
  if (!['browser', 'coreaudio-source'].includes(kind) || kind === 'coreaudio-source' && !/^[a-f0-9]{64}$/.test(executableSHA256 ?? ''))
    throw Error('participant_resource_kind_invalid');
  await mkdir(config.ownedRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(config.ownedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('participant_owner_root_invalid');
  const ownedRoot = await realpath(config.ownedRoot), resourceId = randomUUID();
  const path = resolve(ownedRoot, `${resourceId}.json`);
  let owner = { schema: 1, runId: config.runId, resourceId, host: hostname(), coordinatorPid: process.pid,
    fixtureSHA256, kind, phase: 'launching', createdAtEpochMs: Date.now() };
  await atomicJSON(path, owner);
  async function replace(patch) {
    const current = (await ownerFile(path)).owner;
    if (current.runId !== owner.runId || current.resourceId !== resourceId) throw Error('participant_owner_changed');
    owner = { ...owner, ...patch }; await atomicJSON(path, owner);
  }
  return {
    argument: markerFor(resourceId), path,
    async launched(child) {
      const profileArg = child?.spawnargs?.find(value => value.startsWith('--user-data-dir='));
      if (!Number.isSafeInteger(child?.pid) || child.pid < 1 || !child.spawnargs.includes(markerFor(resourceId))
          || kind === 'browser' && !profileArg || !isAbsolute(child.spawnfile)) throw Error('participant_process_identity_missing');
      const processIdentity = { pid: child.pid, executable: await realpath(child.spawnfile) };
      if (kind === 'browser') processIdentity.profile = await realpath(profileArg.slice('--user-data-dir='.length));
      else processIdentity.executableSHA256 = executableSHA256;
      await replace({ phase: 'active', [kind === 'browser' ? 'browser' : 'nativeHelper']: processIdentity, launchedAtEpochMs: Date.now() });
      return { markerPath: path, ...(await ownerFile(path)) };
    },
    async settled({ signal } = {}) {
      if (!owner.browser && !owner.nativeHelper) throw Error('participant_launch_settlement_unknown');
      const matches = matchingParticipantProcesses(await processInventory(signal), owner);
      if (matches.length) throw Error('participant_process_still_present');
      await replace({ phase: 'closed', lastAbsenceObservedAtEpochMs: Date.now() });
      return { markerPath: path, ...(await ownerFile(path)), matchingProcesses: [] };
    },
  };
}

/** Fresh absence inspection only. It never kills, reconnects to, or issues a
 * command using an old PID. A launch without a completed identity stays unknown. */
export async function inspectParticipantResources({ ownedRoot, runId, signal }) {
  if (!uuid(runId) || !isAbsolute(ownedRoot ?? '') || !(signal instanceof AbortSignal)) throw Error('participant_resource_owner_required');
  signal.throwIfAborted();
  const stat = await lstat(ownedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('participant_owner_root_invalid');
  const names = await readdir(ownedRoot);
  if (!names.length || names.length > 64 || names.some(name => !/^[a-f0-9-]{36}\.json$/.test(name))) throw Error('participant_owner_inventory_invalid');
  const entries = [];
  for (const name of names.sort()) {
    signal.throwIfAborted();
    const { owner, sha256: markerSHA256 } = await ownerFile(resolve(ownedRoot, name));
    if (owner.runId !== runId || name !== `${owner.resourceId}.json`) throw Error('participant_owner_run_mismatch');
    entries.push({ name, owner, markerSHA256 });
  }
  const inventory = await processInventory(signal), observations = [], unresolvedOwnedResources = [];
  for (const { name, owner, markerSHA256 } of entries) {
    signal.throwIfAborted();
    if ((await ownerFile(resolve(ownedRoot, name))).sha256 !== markerSHA256) throw Error('participant_owner_changed');
    const matches = matchingParticipantProcesses(inventory, owner);
    const process = owner.kind === 'coreaudio-source' ? owner.nativeHelper : owner.browser;
    if (!process || !Number.isSafeInteger(process.pid) || !isAbsolute(process.executable ?? '')
        || (owner.kind === 'coreaudio-source' ? !/^[a-f0-9]{64}$/.test(process.executableSHA256 ?? '') : !isAbsolute(process.profile ?? '')))
      unresolvedOwnedResources.push({ resourceId: owner.resourceId, reason: 'launch_identity_missing' });
    else if (matches.length) unresolvedOwnedResources.push({ resourceId: owner.resourceId, reason: 'owned_process_present', processes: matches });
    observations.push({ resourceId: owner.resourceId, markerSHA256, phase: owner.phase, matchingProcesses: matches });
  }
  if (JSON.stringify((await readdir(ownedRoot)).sort()) !== JSON.stringify(names.sort())) throw Error('participant_owner_inventory_changed');
  return { source: 'current-owned-participant-process-inventory', runId, observedAtEpochMs: Date.now(), observations, unresolvedOwnedResources };
}
