import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { options, toolDirectory, sha256 } from './common.mjs';
const { out, native: requireNative } = await options();
const browser = JSON.parse(await readFile(`${out}/BROWSER_TIMINGS.json`, 'utf8'));
const native = requireNative ? JSON.parse(await readFile(`${out}/swift/timing.log`, 'utf8')) : null;
const source = JSON.parse(await readFile(`${out}/SOURCE.json`, 'utf8'));
assert.deepEqual(browser.source, source, 'Report source differs from SOURCE.json');
assert.equal(await sha256(`${out}/web/lab.js`), source.bundleSha256, 'Bundle differs from SOURCE.json');
for (const name of ['lab.js', 'lab.css', 'index.html'])
    assert.equal(await sha256(`${out}/web/${name}`), source.assets[name], 'Built asset differs from SOURCE.json');
if (native)
    assert.equal(JSON.parse(await readFile(`${out}/swift/SOURCE.json`, 'utf8')).commit, source.commit, 'Native and browser source commits differ');
assert.equal(browser.results.length, 20);
if (native)
    assert.equal(native.results.length, 7);
for (const r of browser.results) {
    assert.equal(r.forbiddenMediaCalls, 0);
    assert.equal(r.viewport.width, 390);
    if (!r.name.includes('slow') && !r.name.includes('failure') && !r.name.includes('cancel') && !['startup-error', 'recording-no-input'].includes(r.name))
        assert.equal(r.successWithin4s, true, `${r.name}: fast synthetic case exceeded four seconds`);
    if (r.name.includes('slow'))
        assert.equal(r.successWithin4s, false, `${r.name}: must not count pending/loading as success`);
    if (r.name.includes('failure') || r.name === 'startup-error')
        assert.equal(r.outcome, 'actionable-error');
    if (r.name.includes('cancel'))
        assert.ok(r.marks.cancelSettled - r.marks.cancelClick < 4000);
    if (r.name === 'recording-no-input')
        assert.equal(r.successWithin4s, false);
    if (r.outcome === 'synthetic-input-confirmed') {
        assert.ok(r.marks.syntheticInput1 < r.marks.inputUIReady);
        if (r.name === 'recording-resume')
            assert.ok(r.marks.syntheticInput2 < r.marks.resumeInputReady);
        assert.ok(!r.rpc.some(v => v.action === 'seal'), 'timing must not upload or seal');
    }
}
const fused = browser.results.find(r => r.name === 'current-opening-fused');
const legacy = browser.results.find(r => r.name === 'current-opening-legacy');
assert.equal(fused.rpc.filter(r => r.action === 'capture-operations').length, 0);
assert.equal(legacy.rpc.filter(r => r.action === 'capture-operations' && r.stage === 'start').length, 1);
assert.ok(fused.actionToCompletionMs < legacy.actionToCompletionMs);
if (native) {
    assert.equal(native.physicalIOS, false);
    assert.equal(native.microphone, false);
    assert.equal(native.network, false);
    for (const row of native.results.filter(r => ['cold', 'prewarmed', 'resume', 'lease-delay-650'].includes(r.scenario)))
        assert.equal(row.successWithin4s, true);
    assert.equal(native.results.find(r => r.scenario === 'lease-delay-4500').phaseAt4s, 'starting');
    assert.equal(native.results.find(r => r.scenario === 'lease-delay-4500').successWithin4s, false);
    assert.equal(native.results.find(r => r.scenario === 'cancel-held-lease').sourceIntervals, 0);
    assert.equal(native.results.find(r => r.scenario === 'resume').leaseIssues, 1);
    assert.equal(native.results.find(r => r.scenario === 'resume').uniqueLeaseIntents, 1);
}
const paths = ['SOURCE.json', 'BROWSER_TIMINGS.json', 'web/lab.js', 'web/lab.css', 'web/index.html', ...(native ? ['swift/SOURCE.json', 'swift/timing', 'swift/timing.log'] : [])];
const files = {};
for (const path of paths)
    files[path] = createHash('sha256').update(await readFile(`${out}/${path}`)).digest('hex');
for (const path of ['common.mjs', 'build.mjs', 'browser.mjs', 'build-swift.py', 'timing.swift', 'verify.mjs', 'cli.test.mjs', 'README.md'])
    files[`tool/${path}`] = createHash('sha256').update(await readFile(`${toolDirectory}/${path}`)).digest('hex');
await writeFile(`${out}/VERIFIED.json`, JSON.stringify({ sourceCommit: browser.source.commit, checks: `20 browser scenarios${native ? ' + 7 native host scenarios' : ''}; semantics verified`, realDeviceLatencyMeasured: false, realMicrophone: false, sourceCleanAtBrowserBuild: browser.source.trackedStatus === '', verifiedAt: new Date().toISOString(), files }, null, 2) + '\n');
console.log(`Verified 20 browser cases${native ? ' and 7 Swift host cases' : ''}. Four-second failures remain recorded as failures; no physical-device speed claim.`);
