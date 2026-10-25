import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { atomicJSON, sha256, sameRunIdentity } from './journal.mjs';
import { publishExclusiveJSON } from './guard.mjs';
import { journalIdentity } from './tool-identity.mjs';

export const SESSION_CREATION_TIMEOUT_MS = 180000;
export const RECOVERY_OPERATION_TIMEOUT_MS = 240000;
export const SESSION_ATTEMPT_CAPABILITY = 'scribe:creationAttempt';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fileName = value => /^attempt\.[0-9a-f-]{36}\.json$/.test(value);
async function privateBytes(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o077) !== 0) throw Error('session_attempt_file_unconfirmed');
  return readFile(path);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw Error('session_attempt_owner_unknown'); }
}
export function normalizedSessionCaps(caps) {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw Error('session_capabilities_unconfirmed');
  const result = {};
  for (const [key, value] of Object.entries(caps)) {
    const name = key.replace(/^appium:/, '');
    if (['__proto__', 'constructor', 'prototype'].includes(name)) throw Error('session_capabilities_ambiguous');
    if (Object.hasOwn(result, name)) throw Error('session_capabilities_ambiguous');
    result[name] = value;
  }
  return result;
}
function retention(caps) {
  if (caps.noReset !== true || caps.fullReset === true || caps.forceAppLaunch === true
      || caps.prerun !== undefined || caps.postrun !== undefined || caps.app !== undefined
      || !(caps.shouldTerminateApp === false || caps.skipAppKill === true)) throw Error('session_retention_unconfirmed');
}
export function sessionCapsMatch(actual, expected) {
  try {
    const value = normalizedSessionCaps(actual); retention(value);
    return Object.entries(expected).every(([key, item]) => JSON.stringify(value[key]) === JSON.stringify(item));
  } catch { return false; }
}
async function context(output, scenario) {
  if (typeof output !== 'string') throw Error('session_attempt_output_required');
  const outputCanonical = await realpath(output), runPath = resolve(outputCanonical, 'run.json');
  const bytes = await privateBytes(runPath), journal = JSON.parse(bytes), expected = await journalIdentity(scenario);
  if (!journal.identity || Object.entries(expected).some(([key, value]) => journal.identity[key] !== value)) throw Error('session_attempt_run_mismatch');
  return { outputCanonical, runPath, journalSHA256: sha256(bytes), runIdentity: {
    runId: expected.runId, scenarioSHA256: expected.scenarioSHA256,
    implementationSHA256: expected.implementationSHA256, outputCanonical } };
}
async function receipts(ctx) {
  const root = resolve(ctx.outputCanonical, 'appium-session-attempts');
  let stat;
  try { stat = await lstat(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw Error('session_attempt_directory_unconfirmed');
  const names = (await readdir(root)).filter(name => name.startsWith('attempt.') && name.endsWith('.json'));
  if (names.length > 256 || names.some(name => !fileName(name))) throw Error('session_attempt_inventory_invalid');
  return Promise.all(names.map(async name => {
    const path = resolve(root, name), bytes = await privateBytes(path), receipt = JSON.parse(bytes);
    if (receipt.schema !== 1 || receipt.source !== 'owned-appium-session-creation'
        || !uuid(receipt.attemptId) || name !== `attempt.${receipt.attemptId}.json`
        || !sameRunIdentity(receipt.runIdentity, ctx.runIdentity)
        || !['dispatched', 'returned', 'closed', 'not-dispatched'].includes(receipt.phase)) throw Error('session_attempt_identity_mismatch');
    if (receipt.phase === 'closed' && (!uuid(receipt.sessionId) || !Number.isFinite(receipt.closedAtEpochMs)
        || receipt.cleanup?.deleteAcknowledged !== true || receipt.cleanup?.freshInventoryAbsent !== true
        || receipt.cleanup?.nativeAppTerminationRequested !== false)
        || receipt.phase === 'not-dispatched' && (receipt.sessionId !== undefined || !Number.isFinite(receipt.cancelledAtEpochMs)))
      throw Error('session_attempt_settlement_unconfirmed');
    return { path, receipt, sha256: sha256(bytes) };
  }));
}
async function replace(handle, patch) {
  if (sha256(await privateBytes(handle.path)) !== handle.sha256) throw Error('session_attempt_changed');
  const receipt = { ...handle.receipt, ...patch };
  await atomicJSON(handle.path, receipt);
  handle.receipt = receipt; handle.sha256 = sha256(await privateBytes(handle.path));
}

/** Complete private intent precedes the single POST. A crash in the subsequent
 * dispatch window stays uncertain; an empty discovery result cannot retire it. */
export async function createSessionAttempt({ output, scenario, base, capabilities, targetFingerprint }) {
  const ctx = await context(output, scenario);
  if ((await receipts(ctx)).some(item => !['closed', 'not-dispatched'].includes(item.receipt.phase))) throw Error('session_creation_unsettled');
  if (Object.hasOwn(capabilities, SESSION_ATTEMPT_CAPABILITY)) throw Error('session_attempt_capability_reserved');
  const attemptId = randomUUID(), caps = { ...capabilities, [SESSION_ATTEMPT_CAPABILITY]: attemptId };
  const normalized = normalizedSessionCaps(caps); retention(normalized);
  if (Buffer.byteLength(JSON.stringify(normalized)) > 16000) throw Error('session_capabilities_too_large');
  const root = resolve(ctx.outputCanonical, 'appium-session-attempts');
  await mkdir(root, { recursive: true, mode: 0o700 }); await receipts(ctx);
  const receipt = { schema: 1, source: 'owned-appium-session-creation', phase: 'dispatched', attemptId,
    runIdentity: ctx.runIdentity, runJournalSHA256: ctx.journalSHA256, owner: { pid: process.pid, host: hostname() },
    targetFingerprintSHA256: sha256(targetFingerprint), base, capabilities: normalized,
    dispatchedAtEpochMs: Date.now(), transportTimeoutMs: SESSION_CREATION_TIMEOUT_MS };
  const path = resolve(root, `attempt.${attemptId}.json`);
  await publishExclusiveJSON(path, receipt);
  return { path, receipt, sha256: sha256(await privateBytes(path)), capabilities: caps };
}
export async function sessionReturned(handle, sessionId, capabilities) {
  if (handle.receipt.phase !== 'dispatched') throw Error('session_attempt_phase_invalid');
  if (!uuid(sessionId) || !sessionCapsMatch(capabilities, handle.receipt.capabilities)) throw Error('session_creation_response_unconfirmed');
  await replace(handle, { phase: 'returned', sessionId, returnedAtEpochMs: Date.now() });
}
export async function sessionNotDispatched(handle) {
  if (handle.receipt.phase !== 'dispatched' || handle.receipt.sessionId !== undefined) throw Error('session_attempt_phase_invalid');
  await replace(handle, { phase: 'not-dispatched', cancelledAtEpochMs: Date.now() });
}
export async function sessionClosed(handle, sessionId, evidence) {
  if (!['dispatched', 'returned'].includes(handle.receipt.phase) || !uuid(sessionId) || handle.receipt.sessionId && handle.receipt.sessionId !== sessionId
      || evidence?.deleteAcknowledged !== true || evidence?.freshInventoryAbsent !== true
      || evidence?.nativeAppTerminationRequested !== false) throw Error('session_cleanup_unconfirmed');
  await replace(handle, { phase: 'closed', sessionId, closedAtEpochMs: Date.now(), cleanup: evidence });
}

/** This capability comes only from the same-run recovery guard. Verify its
 * current on-disk owner and target lease again before any driver DELETE. */
async function checkAuthority(authority, ctx, targetFingerprint) {
  const locks = resolve(await realpath(tmpdir()), `scribe-virtual-lab-target-locks-${process.getuid?.() ?? 'user'}`);
  const leasePath = resolve(locks, `${sha256(targetFingerprint)}.lock`);
  if (!authority || authority.leasePath !== leasePath || dirname(authority.guardOwnerPath ?? '') !== leasePath + '.acquiring') throw Error('session_recovery_authority_required');
  if (await realpath(dirname(authority.guardOwnerPath)) !== leasePath + '.acquiring') throw Error('session_recovery_authority_changed');
  const leaseBytes = await privateBytes(leasePath), guardBytes = await privateBytes(authority.guardOwnerPath);
  const lease = JSON.parse(leaseBytes), guard = JSON.parse(guardBytes);
  if (sha256(leaseBytes) !== authority.leaseSHA256 || sha256(guardBytes) !== authority.guardOwnerSHA256
      || lease.uncertain !== true || !sameRunIdentity(lease.runIdentity, ctx.runIdentity)
      || !sameRunIdentity(guard.runIdentity, ctx.runIdentity) || guard.pid !== process.pid || guard.host !== hostname()) throw Error('session_recovery_authority_changed');
}
export async function recoverSessionCreations({ output, scenario, base, targetFingerprint, authority, inventory, close, signal }) {
  const ctx = await context(output, scenario), pending = (await receipts(ctx)).filter(item => !['closed', 'not-dispatched'].includes(item.receipt.phase));
  if (!pending.length) return { recovered: [] };
  await checkAuthority(authority, ctx, targetFingerprint);
  // More than one unresolved factory or any unrelated driver is ambiguous.
  if (pending.length !== 1) throw Error('session_creation_ambiguous');
  const handle = pending[0], receipt = handle.receipt;
  if (receipt.base !== base || receipt.targetFingerprintSHA256 !== sha256(targetFingerprint)
      || receipt.runJournalSHA256 !== ctx.journalSHA256 || receipt.owner?.host !== hostname()
      || !Number.isSafeInteger(receipt.owner.pid) || receipt.owner.pid <= 0
      || !Number.isFinite(receipt.dispatchedAtEpochMs) || !receipt.capabilities
      || receipt.capabilities[SESSION_ATTEMPT_CAPABILITY] !== receipt.attemptId) throw Error('session_creation_recovery_mismatch');
  if (alive(receipt.owner.pid)) throw Error('session_creation_owner_alive');
  signal.throwIfAborted();
  const sessions = await inventory(signal);
  if (!Array.isArray(sessions) || sessions.length !== 1) throw Error('session_creation_still_unconfirmed');
  const candidate = sessions[0];
  if (!uuid(candidate.id) || receipt.sessionId && candidate.id !== receipt.sessionId
      || !Number.isFinite(candidate.created) || candidate.created < receipt.dispatchedAtEpochMs - 1000 || candidate.created > Date.now() + 1000
      || !sessionCapsMatch(candidate.capabilities, receipt.capabilities)) throw Error('session_creation_candidate_mismatch');
  await checkAuthority(authority, ctx, targetFingerprint);
  if (sha256(await privateBytes(ctx.runPath)) !== ctx.journalSHA256) throw Error('session_creation_journal_changed');
  signal.throwIfAborted();
  if (await close(candidate.id, signal) !== true) throw Error('session_creation_close_unconfirmed');
  const after = await inventory(signal);
  if (!Array.isArray(after) || after.length !== 0) throw Error('session_creation_close_unconfirmed');
  await checkAuthority(authority, ctx, targetFingerprint);
  if (sha256(await privateBytes(ctx.runPath)) !== ctx.journalSHA256) throw Error('session_creation_journal_changed');
  await sessionClosed(handle, candidate.id, { source: 'fresh-correlated-driver-inventory', deleteAcknowledged: true,
    freshInventoryAbsent: true, observedCreatedAtEpochMs: candidate.created, nativeAppTerminationRequested: false });
  return { recovered: [{ attemptId: receipt.attemptId, sessionId: candidate.id, receipt: handle.path, receiptSHA256: handle.sha256 }] };
}
