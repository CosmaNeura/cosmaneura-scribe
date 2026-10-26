import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, symlink, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStableNativeJournal, validateIOSJournalPath, requireOwnedJournalExport, projectNativeProcessRow } from './native-journal-export.mjs';

const udid = '48F35BC1-AEA4-486C-A79A-23FAFBA3C2FA';
test('actual Darwin comm-last row retains the complete owned simulator executable', () => {
  const executablePath = `/Users/administrator/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/14EFAC97-6C71-430A-B344-8832B304F37E/Scribe.app/App`;
  const expected = { pid: 63322, processStart: 'Mon Oct 26 02:49:25 2026', executablePath };
  const installed = { executablePath, executableSHA256: 'a'.repeat(64) };
  // Shape retained from read-only Darwin ps; no native process is accessed by this test.
  const row = `  501 Mon Oct 26 02:49:25 2026     ${executablePath}\n`;
  assert.deepEqual(projectNativeProcessRow(row, expected, installed, 501), { ...expected, uid: 501, executableSHA256: 'a'.repeat(64) });
  for (const changed of [
    'Mon Oct 26 02:49:25 2026     /Users/administr   501\n',
    row.replace(executablePath, '/Users/administr'), row.replace('501', '502'),
    row.replace('02:49:25', '02:49:26'), row.replace('14EFAC97', '24EFAC97'), row + row,
  ]) assert.throws(() => projectNativeProcessRow(changed, expected, installed, 501), /process_changed/);
  assert.throws(() => projectNativeProcessRow(row, { ...expected, executablePath: '/foreign' }, installed, 501), /process_unconfirmed/);
});
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
