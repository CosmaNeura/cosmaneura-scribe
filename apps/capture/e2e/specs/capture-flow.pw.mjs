import { expect, test } from "@playwright/test";

import { CapturePage } from "../pages/capture-page.mjs";
import {
  assertCompletionContract,
  assertUploadedEnvelopeContract,
} from "../support/envelope-contract.mjs";
import { installSingleUploadGate, WireJournal } from "../support/wire-journal.mjs";

test("records, survives process death, and completes one encrypted synthetic chunk", async ({
  context,
  page,
}) => {
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

  const wire = new WireJournal(context);
  const uploadGate = await installSingleUploadGate(context);
  try {
    const initial = new CapturePage(page);
    await test.step("open", () => initial.open("idle"));
    await test.step("prepare", () => initial.acceptConsentAndPrepare());
    expect(await page.evaluate(() => globalThis.__captureE2eMediaRequests)).toEqual([]);
    await test.step("start", () => initial.startRecording());
    await test.step("durable_chunk", () => initial.waitForDurableEncryptedChunk());

    const mediaRequests = await page.evaluate(
      () => globalThis.__captureE2eMediaRequests,
    );
    expect(mediaRequests).toEqual([{
      audio: {
        autoGainControl: false,
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: { ideal: 16_000 },
      },
      video: false,
    }]);
    expect(wire.uploadCount).toBe(0);
    expect(wire.registrationCount).toBe(0);
    expect(wire.completionCount).toBe(0);

    wire.beginExpectedPageTermination();
    await page.close({ runBeforeUnload: false });
    wire.endExpectedPageTermination();
    const relaunchedPage = await context.newPage();
    const relaunched = new CapturePage(relaunchedPage);
    await test.step("recover", async () => {
      await relaunched.open("paused");
      await relaunched.assertPausedRecovery();
    });
    expect(wire.uploadCount).toBe(0);
    expect(wire.registrationCount).toBe(0);
    expect(wire.completionCount).toBe(0);

    await test.step("stop_upload", () => relaunched.stopAtHeldUpload());
    await uploadGate.waitUntilHeld();
    uploadGate.release();
    await test.step("complete", () => relaunched.waitForCompletion());

    await expect.poll(() => wire.uploadCount).toBe(1);
    await expect.poll(() => wire.registrationCount).toBe(1);
    await expect.poll(() => wire.completionCount).toBe(1);
    wire.assertSuccessfulResponses();
    wire.assertMutationHeaders();
    assertUploadedEnvelopeContract(wire.firstUpload(), wire.firstRegistration());
    assertCompletionContract(wire.firstCompletion());
  } finally {
    uploadGate.release();
  }
});
