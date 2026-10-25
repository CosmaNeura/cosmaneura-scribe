import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve, dirname } from 'node:path';
import { acquireGuard, publishExclusiveJSON, releaseGuard, sameRunIdentity } from './guard.mjs';
export { sameRunIdentity } from './guard.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const ACTIONS = Object.freeze(['sign_in', 'workspace', 'create_visit', 'prepare', 'consent',
  'record', 'play_source', 'finish', 'review', 'save', 'reopen', 'dashboard']);
const leases = new WeakMap();
/** Mint a same-process lease capability only after an exclusive filesystem
 * claim. Recovery uses this for its guarded, inspected ownership handoff. */
export function targetLeaseHandle(path, owner, targetFingerprint) {
  const assertOwner = async () => {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.token !== owner.token || current.pid !== owner.pid || current.host !== owner.host
        || owner.runIdentity && !sameRunIdentity(current.runIdentity, owner.runIdentity)) throw Error('lock_owner_changed');
    return current;
  };
  const release = async () => { await assertOwner(); await unlink(path); };
  release.quarantine = async () => { const current = await assertOwner(); await atomicJSON(path, { ...current, uncertain: true }); };
  leases.set(release, { targetFingerprint, runIdentity: owner.runIdentity, consumed: false, assertOwner });
  return release;
}
export async function consumeTargetLease(lease, targetFingerprint, runIdentity) {
  const details = leases.get(lease);
  if (!details || details.consumed || details.targetFingerprint !== targetFingerprint || !sameRunIdentity(details.runIdentity, runIdentity)) throw Error('recovery_lease_mismatch');
  await details.assertOwner(); details.consumed = true; return lease;
}
export const targetLeaseConsumed = lease => leases.get(lease)?.consumed === true;
export async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** A single coordinator owns each target. A dead process may be resumed, never stolen. */
export async function lockTarget(directory, targetId, { runIdentity } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${sha256(targetId)}.lock`);
  const guard = `${path}.acquiring`;
  const owner = { pid: process.pid, host: hostname(), token: randomUUID(), ...(runIdentity ? { runIdentity, uncertain: true } : {}) };
  // Serialize stale-lock reclamation as well as creation. Without this guard,
  // two resumptions could both unlink the old file and erase a new owner's lock.
  let guardClaim;
  try { guardClaim = await acquireGuard(guard, { attemptId: owner.token, pid: owner.pid, host: owner.host, ...(runIdentity ? { runIdentity } : {}) }); }
  catch { throw Error('target_locked'); }
  try { for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await publishExclusiveJSON(path, owner);
      return targetLeaseHandle(path, owner, targetId);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await readFile(path, 'utf8'));
      if (previous.uncertain) throw Error('target_requires_reconciliation', { cause: error });
      if (previous.host !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw Error('target_locked', { cause: error });
      try { process.kill(previous.pid, 0); throw Error('target_locked', { cause: error }); }
      catch (probe) { if (probe.code !== 'ESRCH') throw Error('target_locked', { cause: probe }); }
      // Only the owner can normally remove a lock. Recheck before reclaiming a dead one.
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.token !== previous.token) throw Error('target_locked', { cause: error });
      await unlink(path);
    }
  }
  throw Error('target_locked');
  } finally { await releaseGuard(guardClaim); }
}

export class Journal {
  constructor(path, state) { this.path = path; this.state = state; }
  static async load(path, identity, resume, { readOnly = false } = {}) {
    let state;
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state && !resume) throw Error('run_exists_use_resume');
    if (!state && resume) throw Error('run_not_found');
    if (state && JSON.stringify(state.identity) !== JSON.stringify(identity)) throw Error('run_identity_changed');
    if (state) {
      if (state.schema !== 1 || !Array.isArray(state.events) || !Array.isArray(state.completed)) throw Error('journal_integrity_failed');
      let previous = null;
      const completed = []; let pending = null;
      for (const [index, event] of state.events.entries()) {
        if (!event || typeof event !== 'object' || !['preflight', 'action_started', 'action_observed', 'failure', 'cleanup_uncertain', 'capture_quarantined'].includes(event.kind)) throw Error('journal_integrity_failed');
        const { sha256: digest, ...body } = event;
        if (event.sequence !== index || event.previous !== previous || sha256(JSON.stringify(body)) !== digest) throw Error('journal_integrity_failed');
        previous = digest;
        if (['action_started', 'action_observed'].includes(event.kind) && !ACTIONS.includes(event.action)) throw Error('journal_integrity_failed');
        if (event.kind === 'action_started') {
          if (pending !== null || event.action !== ACTIONS[completed.length]) throw Error('journal_integrity_failed');
          pending = event.action;
        } else if (event.kind === 'action_observed') {
          if (pending !== event.action || event.action !== ACTIONS[completed.length]) throw Error('journal_integrity_failed');
          completed.push(event.action); pending = null;
        }
      }
      if (JSON.stringify(completed) !== JSON.stringify(state.completed) || pending !== state.pending) throw Error('journal_integrity_failed');
    }
    state ??= { schema: 1, identity, createdAt: new Date().toISOString(), events: [], pending: null, completed: [], status: 'RUNNING' };
    const journal = new Journal(path, state);
    if (!readOnly) await journal.save(); return journal;
  }
  async save() { await atomicJSON(this.path, this.state); }
  async event(kind, metadata = {}) {
    const previous = this.state.events.at(-1)?.sha256 ?? null;
    const event = { ...metadata, sequence: this.state.events.length, at: new Date().toISOString(), monotonicMs: performance.now(), kind, previous };
    event.sha256 = sha256(JSON.stringify(event)); this.state.events.push(event); await this.save();
  }
  async begin(action) {
    if (this.state.pending) throw Error('unreconciled_action');
    if (!ACTIONS.includes(action) || action !== ACTIONS[this.state.completed.length]) throw Error('action_order_changed');
    this.state.pending = action; await this.event('action_started', { action });
  }
  async finish(action, evidence) {
    if (!ACTIONS.includes(action) || this.state.pending !== action || action !== ACTIONS[this.state.completed.length]) throw Error('action_identity_changed');
    this.state.completed.push(action); this.state.pending = null;
    await this.event('action_observed', { action, evidence });
  }
}
