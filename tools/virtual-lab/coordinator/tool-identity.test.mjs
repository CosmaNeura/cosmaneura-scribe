import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { implementationReceipt } from './tool-identity.mjs';

test('implementation identity binds exact runtime bytes and inventory, excluding tests, docs and mtimes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'scribe-tool-identity-'));
  try {
    for (const directory of ['coordinator', 'native', 'zoom']) await mkdir(resolve(root, directory));
    await writeFile(resolve(root, 'lab.sh'), '#!/bin/sh\nexit 0\n');
    const module = resolve(root, 'coordinator/run.mjs');
    await writeFile(module, 'export const value = 1;');
    const first = await implementationReceipt({ root });
    await writeFile(resolve(root, 'coordinator/run.test.mjs'), 'test-only');
    await writeFile(resolve(root, 'coordinator/README.md'), 'docs');
    await writeFile(resolve(root, 'zoom/self-test.mjs'), 'test-only');
    await writeFile(resolve(root, 'native/test_guards.py'), 'test-only');
    await writeFile(resolve(root, 'coordinator/microphone-source.test.swift'), 'test-only');
    await utimes(module, 1, 1);
    assert.deepEqual(await implementationReceipt({ root }), first);
    await writeFile(module, 'export const value = 2;');
    const changed = await implementationReceipt({ root }); assert.notEqual(changed.sha256, first.sha256);
    await writeFile(resolve(root, 'native/new-observer.mjs'), 'export {};');
    assert.notEqual((await implementationReceipt({ root })).sha256, changed.sha256);
    for (const [path, bytes] of [['native/lab.py', 'print(1)'], ['coordinator/audio.swift', 'print(1)'], ['lab.sh', '#!/bin/sh\nexit 1\n']]) {
      const before = await implementationReceipt({ root });
      await writeFile(resolve(root, path), bytes);
      assert.notEqual((await implementationReceipt({ root })).sha256, before.sha256);
    }
    await symlink(module, resolve(root, 'zoom/escape.mjs'));
    await assert.rejects(implementationReceipt({ root }), /tool_implementation_file_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
