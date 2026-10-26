import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectKernelClockSample as project, boundKernelClockWindow as window, boundNativeResponse as response } from './kernel-clock.mjs';

const runId = 'f7cb7381-a86a-47cc-a4e5-9e7c9fd118a6';
const identity = { hostname: 'owned.example', hardwareSHA256: 'a'.repeat(64), bootSessionUUID: runId, pid: 123, parentPID: 124 };
function input({ sequence = 1, raw = 24000000n, sleep = 12000000n, numer = 125, denom = 3 } = {}) {
  const ns = ticks => ticks * BigInt(numer) / BigInt(denom), seconds = ticks => Number(ns(ticks)) / 1e9;
  const nonce = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  return { expectedNonce: nonce, expectedRunId: runId, expectedIdentity: { ...identity }, nodeVersion: '24.22.1', uvVersion: '1.53.0',
    nodeSentNs: String(ns(raw + sleep - 4n)), nodeReceivedNs: String(ns(raw + sleep + 4n)),
    reply: { schema: 1, source: 'owned-kernel-clock', runId, nonce, sequence, identity: { ...identity }, timebase: { numer, denom },
      continuousBeforeTicks: String(raw + sleep - 3n), continuousAfterTicks: String(raw + sleep + 3n),
      absoluteBeforeTicks: String(raw - 2n), absoluteAfterTicks: String(raw + 2n), dispatchRawTicks: String(raw), dispatchUptimeNs: String(ns(raw)),
      audioBeforeSeconds: seconds(raw - 2n), audioAfterSeconds: seconds(raw + 2n),
      audioBeforeRoundTripTicks: String(raw - 2n), audioAfterRoundTripTicks: String(raw + 2n),
      apiResolutionNs: { uptimeRaw: '1', monotonicRaw: '1' } } };
}
const after = options => input({ sequence: 2, raw: 48000000n, ...options });

test('continuous Node time has a nonzero sleep offset from native uptime', () => {
  const a = project(input()), b = project(after());
  assert.equal(a.dispatchUptimeNs, '1000000000');
  assert.equal(a.nodeContinuousMinusNativeUptimeLowerNs, '499999874');
  const w = window(a, b);
  assert.equal(w.status, 'BOUNDED_NO_RESOLVED_SLEEP_CHANGE');
  assert.equal(w.offsetLowerNs, '499999874');
  assert.equal(w.offsetUpperNs, '500000126');
  assert.equal(w.uncertaintyWidthNs, '252');
  assert.equal(w.browserPrecision, 'UNKNOWN');
  assert.equal(w.nativeSessionAttribution, 'REQUIRES_OWNED_PROCESS_JOURNAL_PROOF');
});

test('zero sleep allows continuous-before to precede absolute-before', () => {
  const w = window(project(input({ sleep: 0n })), project(after({ sleep: 0n })));
  assert.equal(w.offsetLowerNs, '-126'); assert.equal(w.offsetUpperNs, '126');
});

test('sleep offset growth is retained and refuses performance classification', () => {
  const w = window(project(input()), project(after({ sleep: 24000000n })));
  assert.equal(w.status, 'SLEEP_OFFSET_CHANGED');
  assert.equal(w.qualification, 'NOT_ESTABLISHED');
  assert.throws(() => response({ window: w, nodeActionLowerNs: '1500000000', nodeActionUpperNs: '1500000001', nativeEventNs: '1500000000', budgetNs: '4000000000' }));
});

test('integer outward bounds remain exact beyond safe Number integer range', () => {
  const raw = 9007199254740000n;
  const a = project(input({ raw, sleep: 500n, numer: 1, denom: 1 }));
  const b = project(after({ raw: raw + 1000n, sleep: 500n, numer: 1, denom: 1 }));
  assert.equal(window(a, b).offsetLowerNs, '496');
});

for (const [name, change] of [
  ['wrong Node semantics', v => { v.nodeVersion = '22.0.0'; }],
  ['wrong libuv semantics', v => { v.uvVersion = '1.52.0'; }],
  ['foreign run', v => { v.reply.runId = '00000000-0000-4000-8000-000000000001'; }],
  ['mismatched nonce', v => { v.reply.nonce = '00000000-0000-4000-8000-000000000009'; }],
  ['wrong process', v => { v.reply.identity.pid++; }],
  ['wrong parent', v => { v.reply.identity.parentPID++; }],
  ['wrong boot', v => { v.reply.identity.bootSessionUUID = '00000000-0000-4000-8000-000000000001'; }],
  ['wrong hardware', v => { v.reply.identity.hardwareSHA256 = 'b'.repeat(64); }],
  ['unknown field', v => { v.reply.wallClock = 123; }],
  ['reversed request bracket', v => { v.nodeSentNs = v.nodeReceivedNs; v.nodeReceivedNs = '1'; }],
  ['two-second deadline exceeded', v => { v.nodeReceivedNs = String(BigInt(v.nodeSentNs) + 2000000001n); }],
  ['cached reply predates request', v => { v.nodeSentNs = v.reply.dispatchUptimeNs; v.nodeReceivedNs = v.reply.dispatchUptimeNs; }],
  ['native sample outside Mach bracket', v => { v.reply.dispatchRawTicks = String(BigInt(v.reply.absoluteAfterTicks) + 1n); }],
  ['wrong Dispatch scaling', v => { v.reply.dispatchUptimeNs = String(BigInt(v.reply.dispatchUptimeNs) + 1n); }],
  ['uint64 multiplication overflow', v => { v.reply.continuousAfterTicks = '18446744073709551615'; }],
  ['uint64 parsing overflow', v => { v.reply.dispatchRawTicks = '18446744073709551616'; }],
  ['zero timebase', v => { v.reply.timebase.denom = 0; }],
  ['noninteger timebase', v => { v.reply.timebase.numer = 1.5; }],
  ['audio round-trip mismatch', v => { v.reply.audioAfterRoundTripTicks = '1'; }],
  ['audio seconds mismatch', v => { v.reply.audioAfterSeconds += 1; }],
  ['infinite audio conversion', v => { v.reply.audioAfterSeconds = Infinity; }],
  ['unbounded helper sequence', v => { v.reply.sequence = 65; }],
]) test(`rejects ${name}`, () => { const value = input(); change(value); assert.throws(() => project(value), /kernel_clock_sample_invalid/); });

test('duplicate, reversed, foreign and forged samples cannot form a window', () => {
  const a = project(input()), b = project(after());
  assert.throws(() => window(a, a)); assert.throws(() => window(b, a));
  assert.throws(() => window({ ...a }, b));
  const foreign = after(); foreign.reply.identity.pid++; foreign.expectedIdentity.pid++;
  assert.throws(() => window(a, project(foreign)));
  const backwards = after({ sleep: 0n }); assert.throws(() => window(a, project(backwards)));
});

test('validated nested samples and window identity cannot be changed afterward', () => {
  const a = project(input()), b = project(after()), w = window(a, b);
  assert.throws(() => { a.identity.pid++; }, TypeError);
  assert.throws(() => { a.nodeContinuousMinusNativeUptimeLowerNs = '0'; }, TypeError);
  assert.throws(() => { w.offsetUpperNs = '0'; }, TypeError);
  assert.throws(() => { w.identity.pid++; }, TypeError);
  assert.throws(() => response({ window: { ...w } }));
});

test('budget results use conservative bounds and retain threshold uncertainty', () => {
  const w = window(project(input()), project(after()));
  const args = { window: w, nodeActionLowerNs: '1600000000', nodeActionUpperNs: '1600000010', nativeEventNs: '1600000000' };
  assert.equal(response({ ...args, budgetNs: '600000000' }).budgetResult, 'WITHIN_BOUND');
  assert.equal(response({ ...args, budgetNs: '400000000' }).budgetResult, 'EXCEEDS_BOUND');
  assert.equal(response({ ...args, budgetNs: '500000000' }).budgetResult, 'INDETERMINATE');
  assert.throws(() => response({ ...args, nativeEventNs: '999999999', budgetNs: '1' }));
  assert.throws(() => response({ ...args, nodeActionUpperNs: '1499999999', budgetNs: '1' }));
  assert.throws(() => response({ ...args, nodeActionLowerNs: '1', budgetNs: '1' }));
  assert.throws(() => response({ ...args, nodeActionUpperNs: '9999999999', budgetNs: '1' }));
  assert.equal(response({ ...args, nativeEventNs: '1100000000', budgetNs: '4000000000' }).budgetResult, 'INDETERMINATE');
});
