import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleDigest, checkBuildReceipt, readBundleInventory, simulatorApplicationBinding } from './native-identity.mjs';

test('installed reader binding requires this guest container and its hash-verified executable', () => {
  const target = { udid: '57895D36-3997-4047-B12F-0DAB046872EC' };
  const path = `/Users/owned/Library/Developer/CoreSimulator/Devices/${target.udid}/data/Containers/Bundle/Application/11111111-1111-4111-8111-111111111111/Scribe.app`;
  const inventory = { executable: 'App', files: { App: 'a'.repeat(64) } };
  assert.equal(simulatorApplicationBinding(path, inventory, target, {}).executablePath, path + '/App');
  for (const bad of [path.replace(target.udid, '57895D36-3997-4047-B12F-0DAB046872ED'),
    path.replace('/Bundle/Application/', '/Data/Application/'), path + '/other.app', '/Applications/Scribe.app'])
    assert.throws(() => simulatorApplicationBinding(bad, inventory, target, {}), /application_unconfirmed/);
  for (const executable of ['../App', '/App', '', null, 'missing'])
    assert.throws(() => simulatorApplicationBinding(path, { ...inventory, executable }, target, {}), /application_unconfirmed/);
});

test('native build binding rejects an unchanged label on a different binary or source', () => {
  const files = { 'Info.plist': 'b'.repeat(64), App: 'a'.repeat(64) };
  const scenario = { sourceSHA: 'c'.repeat(40), build: { number: '41', bundleId: 'test.app', sha256: bundleDigest(files) } };
  const receipt = { source_sha: scenario.sourceSHA, source_dirty: false, build: '41', bundle_id: 'test.app', files, symlinks: {} };
  const inventory = { bundleId: 'test.app', build: '41', files: { App: files.App, 'Info.plist': files['Info.plist'] }, symlinks: {} };
  assert.equal(checkBuildReceipt(receipt, inventory, scenario).fileCount, 2);
  assert.throws(() => checkBuildReceipt(receipt, { ...inventory, files: { ...files, App: 'd'.repeat(64) } }, scenario), /identity_mismatch/);
  assert.throws(() => checkBuildReceipt({ ...receipt, source_sha: 'e'.repeat(40) }, inventory, scenario), /identity_mismatch/);
  assert.throws(() => checkBuildReceipt({ ...receipt, source_dirty: true }, inventory, scenario), /identity_mismatch/);
  assert.throws(() => checkBuildReceipt(receipt, { ...inventory, files: { ...files, 'unexpected.js': 'f'.repeat(64) } }, scenario), /identity_mismatch/);
});
test('switching a framework directory link changes the actual bundle identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-bundle-'));
  try {
    await mkdir(join(root, 'A')); await mkdir(join(root, 'B'));
    await writeFile(join(root, 'A/code'), 'first'); await writeFile(join(root, 'B/code'), 'second');
    await writeFile(join(root, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.app</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
    await symlink('A', join(root, 'Current'));
    const first = await readBundleInventory(root, true);
    await unlink(join(root, 'Current')); await symlink('B', join(root, 'Current'));
    const second = await readBundleInventory(root, true);
    assert.deepEqual(first.files, second.files);
    assert.notEqual(bundleDigest(first.files, first.symlinks), bundleDigest(second.files, second.symlinks));
    assert.equal(first.symlinks.Current, 'A'); assert.equal(second.symlinks.Current, 'B');
  } finally { await rm(root, { recursive: true, force: true }); }
});
