import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { hash } from '../zoom/fixture.mjs';
import { MicrophoneChild, requireMicrophoneRecording, verifyMicrophoneExecutable } from './microphone-source.mjs';

const active = () => new AbortController().signal;
function child(mode) {
  const code = `let buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', bytes => {
    buffer+=bytes; for(;;) {const at=buffer.indexOf('\\n');if(at<0)break;const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(request.command==='close'){process.stdout.write(JSON.stringify({id:request.id,ok:true,media:{state:'closed'}})+'\\n');process.exit(0);}
      if(${JSON.stringify(mode)}==='held')continue;
      if(${JSON.stringify(mode)}==='invalid'){process.stdout.write('not json\\n');continue;}
      process.stdout.write(JSON.stringify({id:request.id,ok:true,media:{state:'silent',command:request.command}})+'\\n');
    }
  });`;
  return spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'ignore'] });
}
test('actual owned child protocol closes cleanly and excludes unsolicited malformed metadata', async () => {
  for (const mode of ['ordinary', 'invalid']) {
    const port = new MicrophoneChild(child(mode));
    try {
      if (mode === 'invalid') await assert.rejects(port.request('status', {}, { signal: active() }), /reply_invalid/);
      else assert.equal((await port.request('status', {}, { signal: active() })).state, 'silent');
    } finally { await port.close(); assert.equal(port.closed, true); }
  }
});
test('abort and timeout keep held child work tracked until the owned child actually exits', async () => {
  const port = new MicrophoneChild(child('held')), controller = new AbortController();
  try {
    const result = port.request('schedule', {}, { signal: controller.signal }); controller.abort();
    await assert.rejects(result, /aborted/); assert.equal(port.pending.size, 1); assert.equal(port.closed, false);
    await assert.rejects(port.request('status', {}, { timeoutMs: 20 }), /timeout/); assert.equal(port.pending.size, 2);
  } finally { await port.close(); assert.equal(port.pending.size, 0); assert.equal(port.closed, true); }
});
test('microphone fixture scheduling requires fresh actual Recording/consent for the same bound session', () => {
  const good = { scope: 'product-ui', targetId: 'owned', sessionId: 'session-a', observedAtEpochMs: Date.now(),
    capture: { sessionId: 'session-a', state: 'recording', nativeState: 'recording', elapsedSeconds: 1 },
    nativeObservation: { source: 'normal-native-recording-response', sessionId: 'session-a', phase: 'recording', busy: false,
      nativeRevision: 1, observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 },
    consent: { sessionId: 'session-a', state: 'granted' } };
  assert.equal(requireMicrophoneRecording(good, 'session-a'), good);
  assert.throws(() => requireMicrophoneRecording(good, 'session-b'), /session_changed/);
  for (const patch of [{ scope: 'fixture' }, { observedAtEpochMs: Date.now() - 2001 },
    { capture: { ...good.capture, nativeState: undefined } }, { consent: { sessionId: 'other', state: 'granted' } },
    { nativeObservation: undefined }, { nativeObservation: { ...good.nativeObservation, busy: true } }]) {
    assert.throws(() => requireMicrophoneRecording({ ...good, ...patch }));
  }
});
test('helper verification refuses default or physical outputs and changed/outside executables', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'scribe-mic-helper-'));
  try {
    const executable = resolve(root, 'owned-helper'), marker = resolve(root, 'target.json'), bytes = Buffer.from('offline hash fixture; never executed');
    await writeFile(executable, bytes); await writeFile(marker, JSON.stringify({ purpose: 'scribe-synthetic-virtual-lab', role: 'owned-ios-simulator', hostname: hostname(), udid: 'owned-fixture' }));
    const target = { root, marker, role: 'owned-ios-simulator', hostname: hostname(), udid: 'owned-fixture' };
    const output = { executable, sha256: hash(bytes), deviceUID: 'BlackHole2ch_UID' };
    assert.equal(await verifyMicrophoneExecutable(output, target), await realpath(executable));
    for (const deviceUID of ['default', 'BuiltInMicrophoneDevice', undefined]) await assert.rejects(verifyMicrophoneExecutable({ ...output, deviceUID }, target));
    await assert.rejects(verifyMicrophoneExecutable({ ...output, executable: process.execPath }, target), /outside/);
    await writeFile(executable, 'changed'); await assert.rejects(verifyMicrophoneExecutable(output, target), /helper_changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
