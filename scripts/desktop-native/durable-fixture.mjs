// Test-only process. Its root key, fake Core and generated-audio helper are
// supplied by the parent fixture. No Keychain or operating-system capture runs.
import { webcrypto } from "node:crypto";
import { DurableDesktopRecordStore } from "../../apps/desktop-companion/src/durable-record-store.ts";
import { DurableDesktopFlowStore } from "../../apps/desktop-companion/src/durable-flow-store.ts";
import { DurableDesktopQueueStorage } from "../../apps/desktop-companion/src/durable-queue-store.ts";
import { DurableDesktopCoverage } from "../../apps/desktop-companion/src/durable-provider-records.ts";
import { NativeProcessPCMDriver } from "../../apps/desktop-companion/src/native-process-driver.ts";
import { DesktopPcmCaptureSource } from "../../apps/desktop-companion/src/pcm-capture-source.ts";
import { CaptureFlowController } from "../../apps/capture/src/flow/controller.ts";
import { CaptureQueue } from "../../apps/capture/src/queue/capture-queue.ts";
import { HttpCaptureBff } from "../../apps/capture/src/bff/http-client.ts";
import { BffCaptureQueueTransport } from "../../apps/capture/src/bff/queue-transport.ts";
import { HttpCiphertextUploadTarget } from "../../apps/capture/src/bff/upload-target.ts";

let claimed = false;
process.on("message", async input => {
  if (claimed) return;
  claimed = true;
  let store, source;
  try {
    if (input.consent !== "invented-all-parties-agreed" || !/^http:\/\/127\.0\.0\.1:[0-9]+$/u.test(input.origin)) throw new Error("fixture_invalid");
    const raw = new Uint8Array(input.rootKey);
    const key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
    raw.fill(0); input.rootKey.fill(0);
    store = await DurableDesktopRecordStore.open({ directory: input.directory, recoveryScope: input.recoveryScope,
      workspaceId: input.workspaceId, key, crypto: webcrypto });
    const flow = new DurableDesktopFlowStore(store.namespace("flow"));
    const queue = new DurableDesktopQueueStorage(store.namespace(`queue:${input.sessionId}`), input.sessionId);
    const coverage = new DurableDesktopCoverage(store.namespace(`coverage:${input.sessionId}`), input.attemptId);
    source = new DesktopPcmCaptureSource(new NativeProcessPCMDriver({ enabled: true,
      helperPath: input.helperPath, helperSha256: input.helperSha256, isSessionActive: () => true,
      getProcessFence: () => input.processFence,
      authorizeSelectedWindow: async () => ({ application: "com.google.Chrome", processID: 1, windowID: 1,
        captureAuthorizedUntil: Date.parse((await flow.getActiveCaptureState()).captureAuthorizedUntil) }) }), coverage.persist);
    const bff = new HttpCaptureBff((url, init) => fetch(typeof url === "string" ? new URL(url, input.origin) : url, init));
    bff.getAudioEncryptionKey = async () => input.published; // Explicit invented RSA owner.
    const controller = new CaptureFlowController({ bff, flowStore: flow, createSessionKey: flow.createSessionKey,
      source, queue: new CaptureQueue(queue, { crypto: webcrypto }), crypto: webcrypto,
      queueTransport: new BffCaptureQueueTransport(bff, new HttpCiphertextUploadTarget([input.origin])) });
    await controller.prepareConfigured(input.sessionId);
    await controller.startRecording();
    await source.stop(); // Complete the small fixture WAV; no upload or flow teardown.
    if ((await queue.list()).filter(record => record.state === "encrypted").length !== 1) throw new Error("fixture_missing_capture");
    process.send({ type: "committed", phase: (await flow.getActiveCaptureState()).phase,
      coverage: (await coverage.load()).phase });
    // Keep SQLite open. The parent SIGKILLs this process, then recovers the WAL.
  } catch {
    await source?.stop().catch(() => undefined);
    store?.close(); process.send?.({ type: "failed" }); process.exit(1);
  }
});
