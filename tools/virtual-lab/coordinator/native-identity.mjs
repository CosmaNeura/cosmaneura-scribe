import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { sha256 } from './journal.mjs';

const exec = promisify(execFile);
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
export const bundleDigest = (files, symlinks = {}) => sha256(JSON.stringify({ files: sorted(files), symlinks: sorted(symlinks) }));
async function within(path, root) {
  const actual = await realpath(path), rel = relative(await realpath(root), actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('path_outside_owned_root');
  return actual;
}

/** Resolve the physical target before taking a lease; display labels are not identity. */
export async function nativeIdentity(config) {
  const target = config.target;
  if (!['owned-ios-simulator', 'owned-macos-guest', 'owned-macos-lab'].includes(target?.role)
      || target.hostname !== hostname()) throw Error('owned_target_required');
  const root = await realpath(target.root);
  const marker = JSON.parse(await readFile(await within(target.marker, root), 'utf8'));
  if (marker.purpose !== 'scribe-synthetic-virtual-lab' || marker.hostname !== hostname()
      || marker.role !== target.role) throw Error('owned_target_marker_mismatch');
  const simulator = target.role === 'owned-ios-simulator';
  if (simulator && (!/^[A-Fa-f0-9-]{36}$/.test(target.udid) || marker.udid !== target.udid)) throw Error('owned_simulator_mismatch');
  // Both Mac roles address the same interactive host and must share its lease.
  return { root, app: await within(config.app.path, resolve(root, 'apps')),
    fingerprint: `${hostname()}:${simulator ? `simulator:${target.udid.toLowerCase()}` : 'mac-interactive-session'}` };
}

const inventoryScript = `import hashlib,json,pathlib,plistlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
files={}; symlinks={}
for path in sorted(root.rglob('*')):
 if path.is_symlink():
  if not path.resolve().is_relative_to(root): raise ValueError('bundle link escapes')
  symlinks[str(path.relative_to(root))]=str(path.readlink())
 if path.is_file():
  digest=hashlib.sha256()
  with path.open('rb') as source:
   for block in iter(lambda:source.read(1048576),b''): digest.update(block)
  files[str(path.relative_to(root))]=digest.hexdigest()
info=plistlib.loads((root/('Info.plist' if sys.argv[2]=='simulator' else 'Contents/Info.plist')).read_bytes())
print(json.dumps({'files':files,'symlinks':symlinks,'bundleId':info.get('CFBundleIdentifier'),'build':str(info.get('CFBundleVersion')),'platform':info.get('DTPlatformName'),'executable':info.get('CFBundleExecutable')}))`;

export async function readBundleInventory(app, simulator, { signal } = {}) {
  return JSON.parse((await exec('python3', ['-c', inventoryScript, app, simulator ? 'simulator' : 'mac'],
    { signal, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout);
}

export function simulatorApplicationBinding(installedPath, inventory, target, verified) {
  const prefix = `/CoreSimulator/Devices/${target.udid}/data/Containers/Bundle/Application/`;
  const suffix = typeof installedPath === 'string' && installedPath.split(prefix);
  if (!suffix || suffix.length !== 2 || !isAbsolute(installedPath)
      || !/^[A-Fa-f0-9-]{36}\/[^/]+\.app$/.test(suffix[1])
      || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(inventory.executable ?? '')
      || !/^[a-f0-9]{64}$/.test(inventory.files?.[inventory.executable] ?? ''))
    throw Error('installed_simulator_application_unconfirmed');
  return { ...verified, installedPath, executablePath: `${installedPath}/${inventory.executable}`,
    executableSHA256: inventory.files[inventory.executable] };
}

export function checkBuildReceipt(receipt, inventory, scenario) {
  if (receipt.source_sha !== scenario.sourceSHA || receipt.source_dirty !== false
      || receipt.bundle_id !== scenario.build.bundleId || String(receipt.build) !== String(scenario.build.number)
      || inventory.bundleId !== scenario.build.bundleId || inventory.build !== String(scenario.build.number)
      || !receipt.files || !receipt.symlinks || !inventory.symlinks || Object.keys(receipt.files).length === 0
      || bundleDigest(receipt.files, receipt.symlinks) !== scenario.build.sha256
      || bundleDigest(inventory.files, inventory.symlinks) !== scenario.build.sha256) throw Error('native_build_identity_mismatch');
  return { sourceSHA: receipt.source_sha, bundleId: inventory.bundleId, build: inventory.build,
    bundleSHA256: bundleDigest(inventory.files, inventory.symlinks), fileCount: Object.keys(inventory.files).length,
    symlinkCount: Object.keys(inventory.symlinks).length };
}

export async function verifyBuild(config, scenario, { signal } = {}) {
  const identity = await nativeIdentity(config), simulator = config.target.role === 'owned-ios-simulator';
  const receipt = JSON.parse(await readFile(config.buildReceipt, 'utf8'));
  const inventory = app => readBundleInventory(app, simulator, { signal });
  const local = await inventory(identity.app), verified = checkBuildReceipt(receipt, local, scenario);
  let installedApplication;
  if (simulator) {
    if (local.platform !== 'iphonesimulator') throw Error('simulator_build_required');
    const installed = (await exec('xcrun', ['simctl', 'get_app_container', config.target.udid, config.app.bundleId, 'app'],
      { signal, timeout: 15000, maxBuffer: 4096 })).stdout.trim();
    if (await realpath(installed) !== installed) throw Error('installed_simulator_application_unconfirmed');
    const installedInventory = await inventory(installed);
    checkBuildReceipt(receipt, installedInventory, scenario);
    installedApplication = simulatorApplicationBinding(installed, installedInventory, config.target, verified);
  }
  return { ...verified, installedSimulatorBundleMatched: simulator ? true : null,
    ...(installedApplication ? { installedApplication } : {}) };
}
