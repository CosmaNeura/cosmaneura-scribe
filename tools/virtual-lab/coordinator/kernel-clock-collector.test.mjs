import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { KernelClockPipe, NATIVE_PERFORMANCE_BUDGETS_NS, createKernelClockCollector } from './kernel-clock-collector.mjs';

const runId = '00000000-0000-4000-8000-000000000001';
const base = { hostname: 'owned-clock-fixture', hardwareSHA256: 'a'.repeat(64), bootSessionUUID: runId };
// Real child pipes with synthetic clock responses. These prove transport and
// lifecycle behavior, not actual Darwin clock mapping or native acceptance.
const program = `
const mode=process.argv[1], base=${JSON.stringify(base)}, runId=${JSON.stringify(runId)};
let sequence=0, buffer='';
process.stdin.setEncoding('utf8'); process.stdin.on('end',()=>process.exit(0));
process.stdin.on('data',bytes=>{buffer+=bytes;let i;
 while((i=buffer.indexOf('\\n'))>=0){const req=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);sequence++;
 if(mode==='silent')continue;
 if(mode==='exit'){process.exit(2);return;}
 const tick=process.hrtime.bigint(), ns=tick.toString(), seconds=Number(tick)/1e9;
 const value={schema:1,source:'owned-kernel-clock',runId,nonce:req.nonce,sequence,
 identity:{...base,pid:process.pid,parentPID:process.ppid},timebase:{numer:1,denom:1},
 continuousBeforeTicks:ns,continuousAfterTicks:ns,absoluteBeforeTicks:ns,absoluteAfterTicks:ns,
 dispatchRawTicks:ns,dispatchUptimeNs:ns,audioBeforeSeconds:seconds,audioAfterSeconds:seconds,
 audioBeforeRoundTripTicks:ns,audioAfterRoundTripTicks:ns,apiResolutionNs:{uptimeRaw:'1',monotonicRaw:'1'}};
 if(mode==='foreignNonce')value.nonce='00000000-0000-4000-8000-000000000099';
 if(mode==='foreignPID')value.identity.pid++;
 if(mode==='repeatedSequence')value.sequence=1;
 if(mode==='badClock')value.continuousBeforeTicks='0';
 const line=JSON.stringify(value)+'\\n';
 if(mode==='extra')process.stdout.write(line+'{}\\n');
 else if(mode==='partialExtra')process.stdout.write(line+'{');
 else if(mode==='oversize')process.stdout.write('x'.repeat(8193));
 else if(mode==='malformed')process.stdout.write('private-invalid-json\\n');
 else if(mode==='stderr')process.stderr.write('private-fixture-error');
 else if(mode==='delayed')setTimeout(()=>process.stdout.write(line),100);
 else if(mode==='fragmented'){process.stdout.write(line.slice(0,30));setTimeout(()=>process.stdout.write(line.slice(30)),5);}
 else process.stdout.write(line);
 }
});`;
async function fixture(mode = 'valid', signal) {
  const child = spawn(process.execPath, ['-e', program, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return new KernelClockPipe(child, { runId, signal, identity: { ...base, pid: child.pid, parentPID: process.pid },
    nodeVersion: '24.22.1', uvVersion: '1.53.0' });
}
test('prospective budgets keep accepted boundaries explicit, not legacy engine values', () => {
  assert.deepEqual(NATIVE_PERFORMANCE_BUDGETS_NS, { cold_launch: '10000000000', warm_launch: '4000000000',
    workspace: '4000000000', preparation: '7000000000', record: '4000000000', resume: '4000000000' });
  assert.equal(Object.isFrozen(NATIVE_PERFORMANCE_BUDGETS_NS), true);
});
test('actual pipes retain fresh raw correlated samples, window, EOF and immutable copied evidence', async () => {
  const pipe = await fixture('fragmented');
  try {
    const first = await pipe.sample(), last = await pipe.sample();
    assert.notEqual(first.nonce, last.nonce); assert.equal(last.sequence, 2);
    assert.equal(pipe.window(first, last).qualification, 'CLOCK_MAPPING_ONLY');
    assert.throws(() => pipe.window(structuredClone(first), last), /collection_unqualified/);
    const a = pipe.snapshot(); a.samples[0].reply.identity.pid = -1;
    assert.notEqual(pipe.snapshot().samples[0].reply.identity.pid, -1);
    assert.equal(pipe.snapshot().nativeSessionAttribution, 'REQUIRES_OWNED_PROCESS_JOURNAL_PROOF');
  } finally {
    const closed = await pipe.close(); assert.equal(closed.ownedResourcesSettled, true); assert.equal(closed.childExit.code, 0);
  }
  assert.equal(pipe.snapshot().failure, null);
  await assert.rejects(pipe.sample(), /closed/);
});
for (const mode of ['foreignNonce', 'foreignPID', 'badClock', 'extra', 'partialExtra', 'oversize', 'malformed', 'stderr', 'exit']) {
  test(`actual ${mode} response poisons later requests and retains only sanitized failure`, async () => {
    const pipe = await fixture(mode);
    try {
      await assert.rejects(pipe.sample(), /kernel_clock_/);
      await assert.rejects(pipe.sample(), /kernel_clock_/);
      assert.equal(pipe.snapshot().sampleCount, 0);
      assert.equal(JSON.stringify(pipe.snapshot()).includes('private-'), false);
    } finally { assert.equal((await pipe.close()).ownedResourcesSettled, true); }
  });
}
test('sequence replay is rejected even with fresh nonce and valid clocks', async () => {
  const pipe = await fixture('repeatedSequence');
  try { await pipe.sample(); await assert.rejects(pipe.sample(), /reply_invalid/); assert.equal(pipe.snapshot().sampleCount, 1); }
  finally { await pipe.close(); }
});
test('whole request deadline and late reply never become a successful sample', async () => {
  const pipe = await fixture('delayed');
  try {
    await assert.rejects(pipe.sample({ deadlineNs: process.hrtime.bigint() + 20_000_000n }), /request_deadline/);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(pipe.snapshot().sampleCount, 0); await assert.rejects(pipe.sample(), /request_deadline/);
  } finally { await pipe.close(); }
});
test('abort after dispatch poisons future samples; a concurrent call does not dispatch', async () => {
  const pipe = await fixture('silent'), controller = new AbortController();
  try {
    const pending = pipe.sample({ signal: controller.signal });
    await assert.rejects(pipe.sample(), /concurrent_request/);
    assert.equal(pipe.sequence, 1); controller.abort();
    await assert.rejects(pending, /request_aborted/); await assert.rejects(pipe.sample(), /request_aborted/);
  } finally { await pipe.close(); }
});
test('pre-aborted and invalid deadlines send nothing; 64 responses is a hard request bound', async () => {
  const pipe = await fixture(), controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(pipe.sample({ signal: controller.signal }));
    await assert.rejects(pipe.sample({ deadlineNs: process.hrtime.bigint() - 1n }), /request_deadline/);
    await assert.rejects(pipe.sample({ deadlineNs: process.hrtime.bigint() + 3_000_000_000n }), /request_deadline/);
    assert.equal(pipe.sequence, 0);
    for (let i = 0; i < 64; i++) await pipe.sample();
    await assert.rejects(pipe.sample(), /request_limit/); assert.equal(pipe.snapshot().sampleCount, 64);
  } finally { await pipe.close(); }
});
test('close during a pending reply rejects it and reaps only the owned child', async () => {
  const pipe = await fixture('silent');
  const pending = pipe.sample(); const rejection = assert.rejects(pending, /collection_closed/);
  const first = pipe.close(), second = pipe.close();
  assert.deepEqual(await first, await second); await rejection;
  assert.equal(pipe.snapshot().failure, 'kernel_clock_collection_closed');
});
test('factory refuses invalid target before any helper spawn', async () => {
  await assert.rejects(createKernelClockCollector({ runId: 'not-uuid', target: {}, executable: '/not-used' }), /target_invalid/);
});
test('collector lifetime cancellation closes its idle child and blocks future measurements', async () => {
  const controller = new AbortController(), pipe = await fixture('valid', controller.signal);
  await pipe.sample(); controller.abort();
  assert.equal((await pipe.close()).ownedResourcesSettled, true);
  await assert.rejects(pipe.sample(), /collector_aborted/);
  assert.equal(pipe.snapshot().qualification, 'NOT_ESTABLISHED');
  assert.equal(pipe.snapshot().sampleCount, 1);
});
