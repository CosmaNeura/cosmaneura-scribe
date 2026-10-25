import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { matchingParticipantProcesses, prepareParticipantOwner } from './resource-owner.mjs';

test('owned process inventory includes descendants and profile orphans without retaining unrelated commands', () => {
  const resourceId = randomUUID(), owner = { resourceId, browser: { profile: '/private/tmp/owned-profile' } };
  const actual = matchingParticipantProcesses(`11 1 chrome --scribe-virtual-lab-owner=${resourceId}\n12 11 helper --type=utility\n13 12 helper\n14 1 chrome --user-data-dir=/private/tmp/owned-profile\n99 1 unrelated --secret=excluded`, owner);
  assert.deepEqual(actual.map(value => value.pid).sort((a,b)=>a-b), [11,12,13,14]);
  assert(!JSON.stringify(actual).includes('secret'));
  assert.deepEqual(matchingParticipantProcesses('11 1 unrelated --other-marker', owner), []);
});
test('owner is persisted before launch and missing child identity cannot be reported settled', async () => {
  const ownedRoot = await mkdtemp(resolve(tmpdir(), 'scribe-owner-'));
  try {
    const owner = await prepareParticipantOwner({ runId: randomUUID(), ownedRoot }, 'a'.repeat(64));
    assert.equal(JSON.parse(await readFile(owner.path)).phase, 'launching');
    await assert.rejects(owner.launched({ pid: 123, spawnfile: '/missing', spawnargs: [] }), /process_identity_missing/);
    await assert.rejects(owner.settled(), /launch_settlement_unknown/);
    const profile = resolve(ownedRoot, 'profile'); await mkdir(profile);
    const receipt = await owner.launched({ pid: 123, spawnfile: process.execPath, spawnargs: [owner.argument, `--user-data-dir=${profile}`] });
    assert.equal(receipt.owner.phase, 'active'); assert.equal(receipt.owner.browser.pid, 123);
  } finally { await rm(ownedRoot, { recursive: true, force: true }); }
});
