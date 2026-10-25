import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { link, lstat, mkdir, open, readFile, rm, unlink } from 'node:fs/promises';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const sameRunIdentity = (a, b) => Boolean(a && b && ['runId', 'scenarioSHA256', 'implementationSHA256', 'outputCanonical'].every(key => a[key] === b[key]));
const renameScript = `import ctypes,errno,json,os,sys
lib=ctypes.CDLL(None,use_errno=True)
if sys.platform=='darwin':
 fn=lib.renamex_np; fn.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint]
 result=fn(os.fsencode(sys.argv[1]),os.fsencode(sys.argv[2]),4)
elif sys.platform.startswith('linux') and hasattr(lib,'renameat2'):
 fn=lib.renameat2; fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
 result=fn(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)
else:
 print(json.dumps({'code':'ENOTSUP'}));sys.exit(1)
if result!=0:
 print(json.dumps({'code':errno.errorcode.get(ctypes.get_errno(),'UNKNOWN')}));sys.exit(1)
`;
async function renameExclusive(from, to) {
  try { await exec('python3', ['-c', renameScript, from, to], { timeout: 10000, maxBuffer: 4096 }); }
  catch (error) {
    let code; try { code = JSON.parse(error.stdout).code; } catch { /* Preserve uncertainty. */ }
    throw Object.assign(Error('guard_atomic_rename_failed'), { code: code ?? 'UNKNOWN' });
  }
}
async function syncDirectory(path) {
  const directory = await open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
async function completeFile(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
/** Publish a complete file atomically without overwriting any existing path. */
export async function publishExclusiveJSON(path, value) {
  const temporary = `${path}.prepared.${randomUUID()}`, bytes = JSON.stringify(value) + '\n';
  try {
    await completeFile(temporary, bytes);
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function privateFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('recovery_guard_identity_unconfirmed');
  return readFile(path);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw Error('recovery_guard_owner_unknown'); }
}

/** Publish a nonempty, fully fsynced guard with atomic NOREPLACE semantics.
 * Node rename alone could replace a legacy empty guard and is not sufficient. */
export async function acquireGuard(path, owner, { recoverDeadOwner = false } = {}) {
  const bytes = JSON.stringify(owner) + '\n', prepared = `${path}.prepared.${randomUUID()}`;
  await mkdir(prepared, { mode: 0o700 });
  try {
    await completeFile(resolve(prepared, 'recovery-owner.json'), bytes); await syncDirectory(prepared);
    try {
      await renameExclusive(prepared, path); await syncDirectory(dirname(path));
      return { path, ownerPath: resolve(path, 'recovery-owner.json'), ownerSHA256: hash(bytes), depth: 0, owner };
    } catch (error) { if (!recoverDeadOwner || !['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
  } finally { await rm(prepared, { recursive: true, force: true }); }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('recovery_guard_identity_unconfirmed');
  let predecessor = resolve(path, 'recovery-owner.json');
  for (let depth = 1; depth <= 64; depth++) {
    const priorBytes = await privateFile(predecessor), prior = JSON.parse(priorBytes);
    if (prior.host !== hostname() || !Number.isSafeInteger(prior.pid) || prior.pid <= 0 || !uuid(prior.attemptId)
        || !sameRunIdentity(prior.runIdentity, owner.runIdentity)) throw Error('recovery_guard_identity_unconfirmed');
    if (alive(prior.pid)) throw Error('recovery_guard_owner_alive');
    const ownerPath = resolve(path, `claim.${hash(priorBytes)}.json`), temporary = resolve(path, `.prepared-owner.${randomUUID()}`);
    try {
      await completeFile(temporary, bytes);
      try { await link(temporary, ownerPath); }
      catch (error) { if (error.code !== 'EEXIST') throw error; predecessor = ownerPath; continue; }
      await syncDirectory(path);
      return { path, ownerPath, ownerSHA256: hash(bytes), depth, owner };
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  throw Error('recovery_guard_chain_limit');
}

export async function releaseGuard(guard) {
  if (hash(await privateFile(guard.ownerPath)) !== guard.ownerSHA256) throw Error('recovery_guard_changed');
  const released = `${guard.path}.released.${guard.owner.attemptId}`;
  await renameExclusive(guard.path, released); await syncDirectory(dirname(guard.path));
  if (hash(await privateFile(resolve(released, relative(guard.path, guard.ownerPath)))) !== guard.ownerSHA256) throw Error('recovery_guard_changed');
  await rm(released, { recursive: true });
}
