import { expect, test } from "@playwright/test";

import { CapturePage } from "../pages/capture-page.mjs";
import {
  assertCompletionContract,
  assertUploadedEnvelopeContract,
} from "../support/envelope-contract.mjs";
import { installSingleUploadGate, WireJournal } from "../support/wire-journal.mjs";

test("uploads and completes a clean synthetic capture without a reload", async ({
  context,
  page,
}) => {
  const wire = new WireJournal(context);
  const uploadGate = await installSingleUploadGate(context);
  try {
    const capture = await startOneChunk(context, page);
    assertNoCompletionTraffic(wire);

    await capture.stopAtHeldUpload();
    await uploadGate.waitUntilHeld();
    uploadGate.release();
    await capture.waitForCompletion();

    await expect.poll(() => wire.uploadCount).toBeGreaterThan(0);
    expect(wire.registrationCount).toBe(wire.uploadCount);
    await expect.poll(() => wire.completionCount).toBe(1);
    wire.assertSuccessfulResponses();
    wire.assertMutationHeaders();
    assertUploadedEnvelopeContract(wire.firstUpload(), wire.firstRegistration());
    assertCompletionContract(wire.firstCompletion(), wire.registrationCount - 1);
  } finally {
    uploadGate.release();
  }
});

test("holds a process-death capture for review across repeated reloads", async ({
  context,
  page,
}) => {
  const wire = new WireJournal(context);
  await startOneChunk(context, page);
  assertNoCompletionTraffic(wire);

  const recoveredPage = await relaunch(context, page, wire);
  const recovered = new CapturePage(recoveredPage);
  await recovered.open("paused");
  await recovered.assertPausedRecovery();
  await recovered.assertRecoveredStopBlocked();
  assertNoCompletionTraffic(wire);

  const recoveredAgainPage = await relaunch(context, recoveredPage, wire);
  const recoveredAgain = new CapturePage(recoveredAgainPage);
  await recoveredAgain.open("paused");
  await recoveredAgain.assertPausedRecovery();
  await recoveredAgain.assertRecoveredStopBlocked();
  assertNoCompletionTraffic(wire);
  wire.assertSuccessfulResponses();
  wire.assertMutationHeaders();
});

async function startOneChunk(context, page) {
  await context.addInitScript(() => {
    globalThis.__captureE2eMediaRequests = [];
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (mediaDevices === undefined) return;
    const original = mediaDevices.getUserMedia.bind(mediaDevices);
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints) => {
        globalThis.__captureE2eMediaRequests.push(structuredClone(constraints));
        return original(constraints);
      },
    });
  });

  const capture = new CapturePage(page);
  await capture.open("idle");
  await capture.acceptConsentAndPrepare();
  expect(await page.evaluate(() => globalThis.__captureE2eMediaRequests)).toEqual([]);
  await capture.startRecording();
  await capture.waitForDurableEncryptedChunk();
  expect(await page.evaluate(() => globalThis.__captureE2eMediaRequests)).toEqual([{
    audio: {
      autoGainControl: false,
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      sampleRate: { ideal: 16_000 },
    },
    video: false,
  }]);
  return capture;
}

async function relaunch(context, page, wire) {
  wire.beginExpectedPageTermination();
  await page.close({ runBeforeUnload: false });
  wire.endExpectedPageTermination();
  return context.newPage();
}

function assertNoCompletionTraffic(wire) {
  expect(wire.uploadCount).toBe(0);
  expect(wire.registrationCount).toBe(0);
  expect(wire.completionCount).toBe(0);
}
