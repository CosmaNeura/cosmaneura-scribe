import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sha256 } from './journal.mjs';

const lab = fileURLToPath(new URL('../', import.meta.url));
const isRuntime = name => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== 'self-test.mjs';

/** Hash maintained executable source, including this inventory implementation.
 * No timestamps, paths outside the lab, generated results or installed secrets
 * enter the receipt. New runtime modules change the sorted file inventory. */
export async function implementationReceipt({ root = lab } = {}) {
  const files = {};
  for (const directory of ['coordinator', 'native', 'zoom']) {
    const directoryStat = await lstat(resolve(root, directory));
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error('tool_implementation_file_invalid');
    for (const name of (await readdir(resolve(root, directory))).filter(isRuntime).sort()) {
      const key = `${directory}/${name}`, path = resolve(root, key), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000000) throw Error('tool_implementation_file_invalid');
      files[key] = sha256(await readFile(path));
    }
  }
  return { schema: 1, files, sha256: sha256(JSON.stringify(files)) };
}

export async function journalIdentity(scenario) {
  const implementation = await implementationReceipt();
  return { runId: scenario.runId, scenarioSHA256: sha256(JSON.stringify(scenario)), executionKind: scenario.executionKind,
    implementationSHA256: implementation.sha256 };
}
