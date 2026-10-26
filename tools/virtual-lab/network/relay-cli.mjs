import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { acquireGuard, publishExclusiveJSON, releaseGuard } from '../coordinator/guard.mjs';
import { parseRelayConfig, startRelay } from './connect-relay.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw Error(code); };
const exec = promisify(execFile);
async function inside(path, root) {
  need(isAbsolute(path), 'relay_absolute_path_required');
  const actual = await realpath(path), rel = relative(root, actual);
  need(rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'relay_owned_path_required');
  return actual;
}
async function privateBytes(path, limit) {
  const stat = await lstat(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && !(stat.mode & 0o077) && stat.size <= limit, 'relay_private_file_required');
  return readFile(path);
}
async function privateDirectory(path) {
  const stat = await lstat(path);
  need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && !(stat.mode & 0o077), 'relay_private_directory_required');
}

/** The CLI is only for the physically verified owned Mac, never the control host.
 * It neither starts Scribe nor grants recording authority. */
export async function main(args = process.argv.slice(2)) {
  need(args.length === 3 && process.platform === 'darwin', 'relay_owned_mac_required');
  process.umask(0o077);
  const [configPath, rootPath, outputPath] = args;
  need([configPath, rootPath, outputPath].every(isAbsolute), 'relay_absolute_path_required');
  const root = await realpath(rootPath), actualConfig = await inside(configPath, root);
  need(actualConfig === resolve(configPath), 'relay_config_symlink');
  const bytes = await privateBytes(actualConfig, 2048), config = parseRelayConfig(bytes);
  const marker = JSON.parse(await readFile(resolve(root, 'target.json'), 'utf8'));
  need(marker.purpose === 'scribe-synthetic-virtual-lab'
    && ['owned-macos-lab', 'owned-macos-guest'].includes(marker.role)
    && marker.hostname === hostname() && marker.hardwareUUIDSHA256 === config.hardwareUUIDSHA256,
  'relay_owned_marker_required');
  const hardware = (await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { timeout: 5000, maxBuffer: 1000000 })).stdout.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)?.[1];
  need(hardware && hash(hardware.toLowerCase()) === config.hardwareUUIDSHA256, 'relay_hardware_mismatch');
  const parent = await inside(dirname(outputPath), root);
  need(parent === resolve(dirname(outputPath)), 'relay_output_symlink');
  await privateDirectory(parent);
  await mkdir(outputPath, { mode: 0o700 });
  const output = await realpath(outputPath);
  const guardRoot = resolve(root, '.native-lab-network');
  await mkdir(guardRoot, { mode: 0o700, recursive: true }); await privateDirectory(guardRoot);
  const sourceFiles = [fileURLToPath(import.meta.url), fileURLToPath(new URL('./connect-relay.mjs', import.meta.url)),
    fileURLToPath(new URL('../coordinator/guard.mjs', import.meta.url))];
  const implementation = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(path))])));
  const executable = await realpath(process.execPath), executableSHA256 = hash(await readFile(executable));
  const processStart = (await exec('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
    { timeout: 5000, maxBuffer: 1024 })).stdout.trim();
  need(processStart.length > 0, 'relay_process_identity_unknown');
  const owner = { host: hostname(), pid: process.pid, processStart, executable, executableSHA256,
    attemptId: randomUUID(), startedAt: new Date().toISOString(), implementation,
    runIdentity: { runId: config.runId, scenarioSHA256: hash(bytes),
      implementationSHA256: hash(JSON.stringify(implementation)), outputCanonical: output } };
  const guard = await acquireGuard(resolve(guardRoot, `tcp-127.0.0.1-${config.listenPort}`), owner);
  await publishExclusiveJSON(resolve(output, 'intent.json'), { ...owner, configSHA256: hash(bytes),
    guardPath: guard.path, guardOwnerSHA256: guard.ownerSHA256 });
  let relay, closed = false, stopRequested = false;
  const requestStop = () => { stopRequested = true; if (relay) void relay.stop(); };
  process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);
  try {
    relay = await startRelay(config);
    need(!stopRequested, 'relay_start_interrupted');
    await publishExclusiveJSON(resolve(output, 'listening.json'), { ...relay.snapshot(), owner });
    console.log(JSON.stringify({ status: 'OWNED_RELAY_LISTENING', runId: config.runId, pid: process.pid,
      listenAddress: '127.0.0.1', listenPort: config.listenPort }));
    const result = await relay.done;
    need(result.state === 'CLOSED' && result.activeConnections === 0, 'relay_close_unconfirmed');
    closed = true;
    await publishExclusiveJSON(resolve(output, 'closed.json'), result);
    await releaseGuard(guard);
    console.log(JSON.stringify({ status: 'OWNED_RELAY_CLOSED', runId: config.runId }));
  } catch (error) {
    if (relay && !closed) {
      const result = await relay.stop();
      closed = result.state === 'CLOSED' && result.activeConnections === 0;
      await publishExclusiveJSON(resolve(output, 'failure-close.json'), result);
    }
    // Failure keeps the guard and all output for exact ownership review.
    await publishExclusiveJSON(resolve(output, 'failure.json'), { status: 'RELAY_FAILED_REVIEW_REQUIRED',
      code: /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'relay_operation_failed',
      socketsClosed: closed, guardRetained: true, nativeRecordingStopped: 'NOT_ESTABLISHED' });
    throw Error('relay_failed_review_required');
  } finally {
    process.removeListener('SIGINT', requestStop); process.removeListener('SIGTERM', requestStop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('relay_failed_review_required'); process.exitCode = 1; });
}
