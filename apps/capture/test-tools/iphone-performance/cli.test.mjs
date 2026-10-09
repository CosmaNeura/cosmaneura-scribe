import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { toolDirectory } from './common.mjs';
const repo = resolve(toolDirectory, '../../../..');
async function fixture(t) {
    const directory = await mkdtemp(resolve(tmpdir(), 'scribe-performance-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}
function rejects(script, args, message) {
    const result = spawnSync(process.execPath, [resolve(toolDirectory, script), ...args], { cwd: repo, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(message), result.stderr);
}
test('requires explicit output outside the checkout', () => {
    rejects('build.mjs', [], 'Pass --output');
    rejects('build.mjs', ['--output', resolve(repo, '..looks-outside')], 'outside the checkout');
});
test('resolves existing symlink parents before checking output', async (t) => {
    const dir = await fixture(t), link = resolve(dir, 'checkout');
    await symlink(repo, link, 'dir');
    rejects('build.mjs', ['--output', resolve(link, 'new-artifact')], 'outside the checkout');
});
test('refuses existing empty and nonempty output without replacing contents', async (t) => {
    const dir = await fixture(t), output = resolve(dir, 'existing');
    await mkdir(output);
    rejects('build.mjs', ['--output', output], 'must not already exist');
    await writeFile(resolve(output, 'sentinel'), 'retained');
    rejects('build.mjs', ['--output', output], 'must not already exist');
    assert.equal(await readFile(resolve(output, 'sentinel'), 'utf8'), 'retained');
});
async function evidence(directory) {
    await mkdir(resolve(directory, 'web'));
    await mkdir(resolve(directory, 'swift'));
    const assets = {};
    for (const name of ['lab.js', 'lab.css', 'index.html']) {
        await writeFile(resolve(directory, 'web', name), 'synthetic');
        assets[name] = createHash('sha256').update('synthetic').digest('hex');
    }
    const source = { commit: 'a'.repeat(40), bundleSha256: assets['lab.js'], assets };
    await writeFile(resolve(directory, 'SOURCE.json'), JSON.stringify(source));
    await writeFile(resolve(directory, 'BROWSER_TIMINGS.json'), JSON.stringify({ source, results: [] }));
    await writeFile(resolve(directory, 'swift/timing.log'), '{}');
    return source;
}
test('verification rejects report source mismatch', async (t) => {
    const dir = await fixture(t);
    await evidence(dir);
    await writeFile(resolve(dir, 'BROWSER_TIMINGS.json'), JSON.stringify({ source: { commit: 'b'.repeat(40) } }));
    rejects('verify.mjs', ['--output', dir], 'Report source differs');
});
test('verification rejects changed emitted JS, CSS and HTML', async (t) => {
    for (const name of ['lab.js', 'lab.css', 'index.html']) {
        const dir = await fixture(t);
        await evidence(dir);
        await writeFile(resolve(dir, 'web', name), 'changed');
        rejects('verify.mjs', ['--output', dir], name === 'lab.js' ? 'Bundle differs' : 'Built asset differs');
    }
});
test('verification rejects mixed browser and native revisions', async (t) => {
    const dir = await fixture(t);
    await evidence(dir);
    await writeFile(resolve(dir, 'swift/SOURCE.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
    rejects('verify.mjs', ['--output', dir, '--native'], 'Native and browser source commits differ');
});
