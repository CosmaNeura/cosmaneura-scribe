import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, symlink, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStableNativeJournal, validateIOSJournalPath, requireOwnedJournalExport } from './native-journal-export.mjs';

const udid = '48F35BC1-AEA4-486C-A79A-23FAFBA3C2FA';
test('only one canonical data container beneath the exact simulator can identify the journal', () => {
  const path = `/Users/owned/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Data/Application/1F51A01E-03DC-44C7-8E8A-A6017FA7317E`;
  assert.equal(validateIOSJournalPath(path, udid), path + '/Library/Caches/scribe-capture-startup-v1.json');
  for (const bad of [path + '/other', path.replace(udid, '00000000-0000-4000-8000-000000000001'), path + '/../escape',
    path.replace('/Users/owned/', '/Users/owned/../'), path.replace('1F51A01E', 'NOTAUUID'), 'relative/' + path])
    assert.throws(() => validateIOSJournalPath(bad, udid), /container_unconfirmed/);
});
test('fixed-size stable file read refuses symlinks and oversized files; missing is explicit', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-journal-read-test-')));
  try {
    const path = join(root, 'journal.json'), bytes = Buffer.from('[]'); await writeFile(path, bytes, { mode: 0o600 });
    const value = await readStableNativeJournal(path); assert.equal(value.status, 'READ'); assert.deepEqual(value.bytes, bytes);
    assert.equal(value.file.size, '2'); assert.throws(() => requireOwnedJournalExport(value), /export_unconfirmed/);
    const link = join(root, 'link'); await symlink(path, link); await assert.rejects(readStableNativeJournal(link), /path_changed/);
    await chmod(path, 0o644); await assert.rejects(readStableNativeJournal(path), /file_unconfirmed/); await chmod(path, 0o600);
    const fifo = join(root, 'fifo'); await promisify(execFile)('/usr/bin/mkfifo', [fifo]);
    await assert.rejects(readStableNativeJournal(fifo), /file_unconfirmed/);
    await writeFile(path, Buffer.alloc(32769)); await assert.rejects(readStableNativeJournal(path), /file_unconfirmed/);
    assert.equal((await readStableNativeJournal(join(root, 'missing'), { allowMissing: true })).status, 'MISSING');
    await assert.rejects(readStableNativeJournal(join(root, 'missing')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
