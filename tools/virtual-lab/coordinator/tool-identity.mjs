import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { sha256 } from './journal.mjs';

const lab = fileURLToPath(new URL('../', import.meta.url));
const isRuntime = name => /\.(?:mjs|py|swift)$/.test(name)
  && !/\.test\.(?:mjs|py|swift)$/.test(name) && !name.startsWith('test_') && name !== 'self-test.mjs';

/** Hash maintained executable source, including this inventory implementation.
 * No timestamps, paths outside the lab, generated results or installed secrets
 * enter the receipt. New runtime modules change the sorted file inventory. */
export async function implementationReceipt({ root = lab } = {}) {
  const files = {};
  const launcher = resolve(root, 'lab.sh'), launcherStat = await lstat(launcher);
  if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || launcherStat.size > 4000000) throw Error('tool_implementation_file_invalid');
  files['lab.sh'] = sha256(await readFile(launcher));
  for (const directory of ['coordinator', 'native', 'zoom']) {
    const directoryStat = await lstat(resolve(root, directory));
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error('tool_implementation_file_invalid');
    for (const name of (await readdir(resolve(root, directory))).filter(isRuntime).sort()) {
      const key = `${directory}/${name}`, path = resolve(root, key), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4000000) throw Error('tool_implementation_file_invalid');
      files[key] = sha256(await readFile(path));
    }
  }
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return { schema: 1, files: ordered, sha256: sha256(JSON.stringify(ordered)) };
}

export async function journalIdentity(scenario) {
  const implementation = await implementationReceipt();
  return { runId: scenario.runId, scenarioSHA256: sha256(JSON.stringify(scenario)), executionKind: scenario.executionKind,
    implementationSHA256: implementation.sha256 };
}
