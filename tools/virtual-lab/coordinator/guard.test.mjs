import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { acquireGuard, publishExclusiveJSON, releaseGuard } from './guard.mjs';

const owner = () => ({ attemptId: randomUUID(), pid: process.pid, host: hostname(), runIdentity: {
  runId: 'guard-unit', scenarioSHA256: 'a'.repeat(64), implementationSHA256: 'b'.repeat(64), outputCanonical: '/private/tmp/guard-unit' } });
test('atomic prepared guard publication never replaces even a legacy empty directory', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'scribe-guard-')), path = resolve(root, 'target.acquiring');
  try {
    await mkdir(path);
    await assert.rejects(acquireGuard(path, owner()), error => ['EEXIST', 'ENOTEMPTY'].includes(error.code));
    assert.deepEqual(await readdir(path), []);
    await assert.rejects(acquireGuard(path, owner(), { recoverDeadOwner: true }), { code: 'ENOENT' });
    assert.deepEqual(await readdir(path), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('normal simultaneous acquisition publishes exactly one complete owner', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'scribe-guard-')), path = resolve(root, 'target.acquiring');
  try {
    const contenders = [owner(), owner()];
    const results = await Promise.allSettled(contenders.map(value => acquireGuard(path, value)));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    const winner = results.find(value => value.status === 'fulfilled').value;
    assert.deepEqual(JSON.parse(await readFile(winner.ownerPath)), winner.owner);
    await releaseGuard(winner); assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('complete lease publication refuses to overwrite an existing owner', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'scribe-guard-')), path = resolve(root, 'target.lock');
  try {
    const first = owner(); await publishExclusiveJSON(path, first);
    const before = await readFile(path);
    await assert.rejects(publishExclusiveJSON(path, owner()), { code: 'EEXIST' });
    assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(root), ['target.lock']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
