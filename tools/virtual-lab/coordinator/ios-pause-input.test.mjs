import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppiumUI } from './appium-ui.mjs';
const fixture = {
  sha256: 'a'.repeat(64)
};
const scope = {
  runId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  appointmentRef: 'appointment_01m5q661ryetaa28yxe7vbqrex',
  sessionId: '33333333-3333-4333-8333-333333333333',
  recorderId: '44444444-4444-4444-8444-444444444444'
};
const media = () => ({
  state: 'paused',
  playing: false,
  completed: false,
  rms: 0,
  graphKind: 'coreaudio-output',
  output: {
    running: true,
    deviceUID: 'BlackHole2ch_UID'
  },
  fixtureSha256: fixture.sha256,
  offsetSeconds: 16.7988125,
  nonzeroOutputFrames: 231954,
  observedAtEpochMs: Date.now()
});
const native = (phase = 'paused', revision = 1) => ({
  ...scope,
  source: 'normal-native-recording-response',
  phase,
  busy: false,
  nativeRevision: revision,
  observedAtMonotonicMs: 1,
  browserTimeOriginMs: Date.now() - 1
});
function pausedDriver() {
  const ui = new AppiumUI('/unused');
  ui.config = {
    target: {
      role: 'owned-ios-simulator'
    },
    sources: {
      quietWindow: [16.7, 17.2]
    }
  };
  let current = media();
  ui.sources = {
    connected: true,
    playing: Promise.resolve(),
    participants: [{
      kind: 'virtual-microphone',
      fixture
    }],
    evidence: {
      pause: [{
        media: media()
      }]
    },
    all: async () => [{
      media: {
        ...current
      }
    }]
  };
  return {
    ui,
    change: fn => fn(current)
  };
}
test('only an actual same-offset silent owned source permits watcher suspension', async () => {
  const {
    ui
  } = pausedDriver();
  const value = await ui.readPausedSource(new AbortController().signal);
  assert.equal(value.offsetSeconds, 16.7988125);
  assert.equal(value.playing, false);
});
test('emission, source change, offset drift, stale read or cancellation cannot suspend watch', async () => {
  for (const change of [v => v.playing = true, v => v.rms = .01, v => v.output = {
    ...v.output,
    deviceUID: 'physical'
  }, v => v.offsetSeconds += .01, v => v.nonzeroOutputFrames++, v => v.fixtureSha256 = 'b'.repeat(64), v => v.observedAtEpochMs -= 3000]) {
    const {
      ui,
      change: apply
    } = pausedDriver();
    apply(change);
    await assert.rejects(ui.readPausedSource(new AbortController().signal), /source_pause_silence_unconfirmed/);
  }
  const {
    ui
  } = pausedDriver();
  await assert.rejects(ui.readPausedSource(AbortSignal.abort(Error('cancelled'))), /cancelled/);
});
function inputDriver() {
  const {
    ui
  } = pausedDriver();
  let current = native(),
    input = {
      assessment: {
        status: 'OBSERVED_ALLOWED'
      },
      halBefore: {
        processes: [{
          runningInput: false
        }]
      },
      hal: {
        processes: [{
          runningInput: false
        }]
      }
    };
  ui.readRecording = async () => ({
    ...current
  });
  ui.verifyInputApplication = async () => ({
    bundleSHA256: 'd'.repeat(64)
  });
  ui.inspectInputScope = async (_signal, required) => {
    assert.equal(required, false);
    return input;
  };
  return {
    ui,
    change: fn => fn(current, input)
  };
}
test('paused input requires same fresh recorder, installed application and complete idle bookends', async () => {
  const {
    ui
  } = inputDriver();
  const value = await ui.inspectPausedInput(native(), new AbortController().signal);
  assert.equal(value.after.recorderId, scope.recorderId);
  assert(value.application);
  for (const change of [n => n.recorderId = '55555555-5555-4555-8555-555555555555', n => n.nativeRevision = 0, n => n.browserTimeOriginMs -= 3000, n => n.phase = 'recording', (_n, h) => h.assessment.status = 'BLOCKED', (_n, h) => h.hal.processes.push({
    runningInput: true
  }), (_n, h) => h.halBefore.processes = []]) {
    const item = inputDriver();
    item.change(change);
    await assert.rejects(item.ui.inspectPausedInput(native(), new AbortController().signal), /paused_native_scope_changed|paused_input_not_idle/);
  }
});
test('changed build and aborted paused proof cannot reach Resume', async () => {
  const {
    ui
  } = inputDriver();
  ui.verifyInputApplication = async () => null;
  await assert.rejects(ui.inspectPausedInput(native(), new AbortController().signal), /installed_simulator_application_unconfirmed/);
  const second = inputDriver();
  await assert.rejects(second.ui.inspectPausedInput(native(), AbortSignal.abort(Error('cancelled'))), /cancelled/);
});
async function integration(mode = 'normal') {
  const output = await mkdtemp(join(tmpdir(), 'scribe-ios-pause-segments-')),
    sourceLife = new AbortController(),
    ui = new AppiumUI('/unused');
  let phase = 'recording',
    revision = 1,
    closed = false;
  const events = [];
  const admission = {
    ...scope,
    source: 'normal-native-admission-response',
    consentRecordId: '55555555-5555-4555-8555-555555555555',
    observedAtMonotonicMs: 1,
    browserTimeOriginMs: Date.now() - 1
  };
  ui.output = output;
  ui.scenario = {
    acceptanceScope: {
      pauseResume: true
    }
  };
  ui.admission = admission;
  ui.lastNativeRecording = native('recording');
  ui.initialMicrophoneObservation = native('recording');
  ui.config = {
    target: {
      role: 'owned-ios-simulator'
    },
    sources: {
      quietWindow: [16.7, 17.2],
      participants: [{
        kind: 'virtual-microphone'
      }],
      inputCustody: {}
    },
    journey: {
      pause: {
        actions: [{
          action: 'click',
          locator: {
            value: 'Pause'
          }
        }],
        assertions: [{}]
      },
      resume: {
        actions: [{
          action: 'click',
          locator: {
            value: 'Resume recording'
          }
        }],
        assertions: [{}]
      }
    }
  };
  ui.assertVisit = async () => {};
  ui.assertMicrophoneSignal = () => {};
  ui.webview = async () => native(phase, revision);
  ui.inspectInputScope = async (signal, required) => {
    signal.throwIfAborted();
    events.push('proof:' + phase + ':' + required);
    return {
      assessment: {
        status: required && phase !== 'recording' || mode === 'foreign-before-resume' && !required || mode === 'foreign-after-resume' && required && revision > 1 ? 'BLOCKED' : 'OBSERVED_ALLOWED'
      },
      halBefore: {
        processes: [{
          runningInput: false
        }]
      },
      hal: {
        processes: [{
          runningInput: false
        }]
      }
    };
  };
  ui.verifyInputApplication = async () => ({
    bundleSHA256: 'd'.repeat(64)
  });
  ui.steps = async (plan, signal) => {
    signal.throwIfAborted();
    const pause = plan === ui.config.journey.pause;
    events.push(pause ? 'Pause' : 'Resume');
    phase = pause ? 'stopping' : 'starting';
    revision++;
    if (pause && mode === 'pause-cancel') sourceLife.abort(Error('pause_cancelled'));
    if (pause && mode === 'pause-error') throw Error('pause_failed');
    await delay(pause ? 1100 : 10);
    signal.throwIfAborted();
    if (mode === 'resume-error' && !pause) throw Error('resume_failed');
    phase = pause ? 'paused' : 'recording';
    revision++;
  };
  ui.check = async (_plan, signal) => {
    signal.throwIfAborted();
    return [];
  };
  ui.observe = async () => ({
    checks: [],
    nativeObservation: await ui.readRecording()
  });
  ui.sources = {
    connected: true,
    playing: Promise.resolve(),
    participants: [{
      kind: 'virtual-microphone',
      fixture
    }],
    evidence: {
      pause: [{
        media: media()
      }]
    },
    all: async () => [{
      media: media()
    }],
    cleanup: async () => {
      closed = true;
      sourceLife.abort(Error('source_closed'));
      return {
        ownedResourcesSettled: true
      };
    },
    play: async ({
      signal,
      pause,
      resume
    }) => {
      const active = AbortSignal.any([signal, sourceLife.signal]);
      await pause({
        signal: active
      });
      events.push('pause-settled');
      await resume({
        signal: active
      });
      assert(ui.inputWatch, 'fresh watch must exist before source resumes');
      events.push('source-rescheduled');
      return {
        executionKind: 'live',
        sourceState: 'ended',
        measurements: [{
          fixtureSHA256: fixture.sha256,
          framesCompleted: 2433509,
          pausePerformed: true
        }]
      };
    }
  };
  try {
    const result = await ui.perform('play_source', ui.scenario, AbortSignal.timeout(6000));
    const receipt = JSON.parse(await readFile(join(output, 'hal-input-scope.json'), 'utf8'));
    return {
      result,
      events,
      closed,
      receipt
    };
  } catch (error) {
    error.events = events;
    throw error;
  } finally {
    await ui.stopInputWatch();
    await rm(output, {
      recursive: true,
      force: true
    });
  }
}
test('real watcher drains before native Pause and restarts before source rescheduling; both segments remain', async () => {
  const v = await integration();
  assert.equal(v.closed, false);
  assert.deepEqual(v.events.filter(e => ['Pause', 'Resume', 'source-rescheduled'].includes(e)), ['Pause', 'Resume', 'source-rescheduled']);
  assert(!v.events.some(e => e.startsWith('proof:stopping') || e.startsWith('proof:starting')));
  assert.equal(v.receipt.segments.length, 2);
  assert(v.receipt.samples.length >= 2);
  assert.equal(v.result.pauseResume.resume.inputBeforeResume.after.phase, 'paused');
});
test('foreign paused reader or failed Resume prevents source rescheduling', async () => {
  for (const mode of ['foreign-before-resume', 'resume-error']) await assert.rejects(integration(mode), error => {
    assert(!error.events.includes('source-rescheduled'));
    if (mode === 'foreign-before-resume') assert(!error.events.includes('Resume'));
    return /paused_input_not_idle|resume_failed/.test(error.message);
  });
});

test('Pause failure, cancellation and a foreign reader after Resume prevent source scheduling', async () => {
  for (const mode of ['pause-error', 'pause-cancel', 'foreign-after-resume']) {
    await assert.rejects(integration(mode), error => {
      assert(!error.events.includes('source-rescheduled'));
      if (mode !== 'foreign-after-resume') assert(!error.events.includes('Resume'));
      return /pause_failed|pause_cancelled|virtual_input_scope_changed/.test(error.message);
    });
  }
});
