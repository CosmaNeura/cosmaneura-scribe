import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AppiumUI } from './appium-ui.mjs';
import { assessHALScope } from './hal-watch.mjs';

const actual = JSON.parse(await readFile(new URL('./fixtures/ios-paused-hal.json', import.meta.url), 'utf8'));
const options = receipt => ({ target: actual.target, expectedService: actual.inputCustody.expectedService,
  expectedApplication: receipt.application, expectedRecording: actual.initialRecording,
  requireOwnedInput: false, now: receipt.observedAtEpochMs });

// Execute the real adapter method; replace only its external metadata collector
// with a retained actual receipt and the production classifier. No source/UI runs.
function driver(receipt) {
  let requested;
  const collect = async args => {
    requested = args;
    return { ...receipt, assessment: assessHALScope(receipt, { ...args, now: receipt.observedAtEpochMs }) };
  };
  const implementation = AppiumUI.prototype.inspectInputScope.toString()
    .replace(/^async inspectInputScope/, 'async function inspectInputScope');
  const inspect = Function('inspectHALScope', 'AbortSignal', 'performance', 'Date', `return (${implementation});`)(
    collect, AbortSignal, performance, { now: () => receipt.observedAtEpochMs });
  const ui = {
    config: { target: actual.target, sources: { inputCustody: actual.inputCustody } },
    initialMicrophoneObservation: actual.initialRecording, inputReader: actual.expectedReader,
    readRecording: async () => receipt.nativeRecording,
    verifyInputApplication: async () => receipt.application,
  };
  return { ui, requested: () => requested, inspect: required => inspect.call(ui, new AbortController().signal, required) };
}

test('actual idle Pause snapshots reject a recording-reader latch and permit the unchanged idle classifier', () => {
  for (const sample of [actual.paused.halBefore, actual.paused.hal]) {
    assert.equal(sample.completeSnapshot, true);
    assert(sample.processes.every(row => row.runningInput === false));
  }
  assert.deepEqual(assessHALScope(actual.paused, { ...options(actual.paused), expectedReader: actual.expectedReader }).reasons,
    ['latched_input_reader_changed']);
  assert.equal(assessHALScope(actual.paused, options(actual.paused)).status, 'OBSERVED_ALLOWED');
});

test('real adapter idle inspection omits the active-reader expectation without clearing its latch', async () => {
  const d = driver(actual.paused), latched = d.ui.inputReader;
  const result = await d.inspect(false);
  assert.equal(result.assessment.status, 'OBSERVED_ALLOWED');
  assert.equal(d.requested().expectedReader, undefined);
  assert.equal(d.ui.inputReader, latched);
});

test('resumed recording still requires the same real installed reader', async () => {
  const d = driver(actual.recording);
  assert.equal((await d.inspect(true)).assessment.status, 'OBSERVED_ALLOWED');
  assert.equal(d.requested().expectedReader, actual.expectedReader);
  d.ui.inputReader = { ...actual.expectedReader, processIdentity: { ...actual.expectedReader.processIdentity, pid: 999999 } };
  const changed = await d.inspect(true);
  assert.equal(changed.assessment.status, 'BLOCKED');
  assert(changed.assessment.reasons.includes('latched_input_reader_changed'));
});

test('foreign input remains blocked during the idle proof', async () => {
  const receipt = structuredClone(actual.paused);
  for (const sample of [receipt.halBefore, receipt.hal]) {
    const row = sample.processes.find(value => value.pid === 54014);
    row.runningInput = true;
    row.bundleId = 'foreign.synthetic.reader';
    row.inputDevices = [{ uid: 'BlackHole2ch_UID', transportType: 1987208564, isAggregate: false }];
  }
  const result = await driver(receipt).inspect(false);
  assert.equal(result.assessment.status, 'BLOCKED');
  assert(result.assessment.reasons.includes('foreign_or_unconfirmed_virtual_input_client'));
});
