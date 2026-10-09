import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HttpCaptureBff } from "../../capture/src/bff/http-client";
import { BffCaptureQueueTransport } from "../../capture/src/bff/queue-transport";
import { HttpCiphertextUploadTarget } from "../../capture/src/bff/upload-target";
import { CaptureFlowController } from "../../capture/src/flow/controller";
import { createMockBffServer } from "../../capture/src/mock-bff/server";
import { CaptureQueue } from "../../capture/src/queue/capture-queue";
import { DurableDesktopFlowStore } from "./durable-flow-store.js";
import { DurableDesktopQueueStorage } from "./durable-queue-store.js";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import type { DesktopPCMDriver, DesktopPCMStart } from "./native-pcm-driver.js";
import { passageWav, retainPassageAudio } from "./passage-playback.js";
import { DesktopPcmCaptureSource } from "./pcm-capture-source.js";

const root = process.env.SCRIBE_SYNTHETIC_SPEECH_DIRECTORY;
const names = ["microphone-44100", "microphone-48000", "meeting-32000", "meeting-48000"];
const cases = names.flatMap(name => [false, true].map(recover => ({ name, recover })));
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const start: DesktopPCMStart = { hostTimeNanoseconds: "1000000000",
  microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" };

// Reads only opt-in PCM emitted by the real native generated-speech tests.
// No source, window, account, Keychain or OS permission is opened.
async function speech(name: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!root) throw new Error("native synthetic speech output required");
  const consentBytes = await readFile(join(root, "synthetic-consent.json"));
  const consent = JSON.parse(consentBytes.toString()) as Record<string, unknown>;
  expect(consent).toMatchObject({ schema: 1, generator: "macos-say-synthetic-v1",
    synthetic_only: true, all_parties_consented: true });
  const receipt = JSON.parse(await readFile(join(root, `${name}.json`), "utf8")) as Record<string, unknown>;
  expect(receipt).toMatchObject({ schema: 1, synthetic_only: true, name, sample_rate_hz: 16_000,
    consent_sha256: digest(consentBytes) });
  const bytes = new Uint8Array(await readFile(join(root, `${name}.pcm`)));
  expect(bytes.length).toBeGreaterThan(32_000); expect(bytes.length).toBeLessThanOrEqual(30 * 32_000);
  expect(receipt.frames).toBe(bytes.length / 2); expect(receipt.pcm_sha256).toBe(digest(bytes));
  // Whole-second native timelines permit recovery without discarding a subchunk.
  expect(bytes.length % 32_000).toBe(0);
  return bytes;
}

class VirtualDriver implements DesktopPCMDriver {
  active = false;
  starts = 0;
  frames = 0;
  tail = new Uint8Array(0);
  sink?: Parameters<DesktopPCMDriver["start"]>[1];
  getAvailability(): Promise<boolean> { return Promise.resolve(true); }
  start(_configuration: Parameters<DesktopPCMDriver["start"]>[0], sink: Parameters<DesktopPCMDriver["start"]>[1]) {
    this.starts++; this.sink = sink;
    return { ready: Promise.resolve(start), activate: () => { this.active = true; },
      stop: async ({ mode }: { mode: "drain" | "discard" }) => {
        if (mode === "drain" && this.tail.length) await this.emit(this.tail);
        this.tail.fill(0); this.active = false;
        return mode === "discard" ? null : { start, outputFrames: this.frames,
          endHostTimeNanoseconds: String(1_000_000_000n + BigInt(this.frames) * 62_500n),
          microphoneTailNanoseconds: "0", systemTailNanoseconds: "0" };
      } };
  }
  async emit(input: Uint8Array): Promise<void> {
    expect(this.active).toBe(true);
    const bytes = new Uint8Array(input), firstFrame = this.frames;
    this.frames += bytes.length / 2;
    await this.sink!.onPcmPacket({ firstFrame, pcmBytes: bytes });
    expect(bytes.every(value => value === 0)).toBe(true);
  }
}

describe.skipIf(!root)("native fictional speech through desktop encryption and playback", () => {
  it.each(cases)(
    "$name retains both voices through stop/upload/playback (reopen: $recover)", async ({ name, recover }) => {
      // Consent is validated before any generated audio is read or processed.
      const pcm = await speech(name), directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-virtual-speech-")));
      const master = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false,
        ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
      const options = { directory, workspaceId: crypto.randomUUID(), recoveryScope: crypto.randomUUID(), key: master };
      let store = await DurableDesktopRecordStore.open(options);
      const server = createMockBffServer();
      const controllers: CaptureFlowController[] = [];
      try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const bff = new HttpCaptureBff((input, init) => fetch(typeof input === "string" ? new URL(input, origin) : input, init));
        const person = { appointment_id: "virtual-speech-appointment", practitioner_id: "virtual-speech-provider", patient_id: "virtual-speech-patient" };
        // The existing synthetic preview accepts only in-person consent. These
        // cases qualify both audio paths; modality policy is not under test.
        const modality = "in_person" as const;
        const consent = await bff.createConsent({ ...person, participant_regions: ["US-NY"], modality,
          method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() },
        { idempotencyKey: "virtual-speech-consent" });
        const session = await bff.createSession({ ...person, consent_record_id: consent.id, modality },
          { idempotencyKey: "virtual-speech-session" });
        const capabilities = await bff.getCapabilities(session.id);
        vi.spyOn(bff, "getCapabilities").mockResolvedValue({ ...capabilities, target_chunk_duration_ms: 1000 });
        const complete = vi.spyOn(bff, "completeCapture"), upload = new HttpCiphertextUploadTarget([origin]);
        const put = vi.spyOn(upload, "putCompleteEnvelope");
        const make = (driver: VirtualDriver) => {
          const flow = new DurableDesktopFlowStore(store.namespace("flow"));
          const queue = new DurableDesktopQueueStorage(store.namespace(`queue:${session.id}`), session.id, async record => {
            await flow.retainPlaybackKey(session.id, store.namespace(`playback-key:${session.id}`));
            await retainPassageAudio(store.namespace(`playback:${session.id}`), record);
          });
          const controller = new CaptureFlowController({ bff, flowStore: flow, queue: new CaptureQueue(queue, { crypto }),
            createSessionKey: flow.createSessionKey, crypto, storageCapacity: { availableBytes: async () => 10_000_000_000 },
            source: new DesktopPcmCaptureSource(driver, async () => undefined),
            queueTransport: new BffCaptureQueueTransport(bff, upload) });
          controllers.push(controller); return { flow, queue, controller };
        };
        const driver = new VirtualDriver(), initial = make(driver);
        await initial.controller.prepareConfigured(session.id); expect(driver.starts).toBe(0);
        await initial.controller.startRecording();
        const delivered = recover ? pcm.length : pcm.length - 14;
        for (let position = 0; position < delivered; position += 8000) {
          await driver.emit(pcm.subarray(position, Math.min(delivered, position + 8000)));
        }
        let current = initial;
        if (recover) {
          await initial.controller.deactivate(); expect(driver.active).toBe(false);
          expect(complete).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
          expect((await initial.flow.getActiveCaptureState())?.phase).toBe("paused");
          store.close(); store = await DurableDesktopRecordStore.open(options);
          const dormant = new VirtualDriver(); current = make(dormant);
          expect(await current.controller.restore()).toBe(true); expect(dormant.starts).toBe(0);
        } else driver.tail = pcm.slice(delivered);
        await current.controller.stopRecording();
        expect(current.controller.snapshot.state).toBe("processing"); expect(complete).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledTimes(pcm.length / 32_000);
        expect((await current.queue.listMetadata()).filter(row => row.state === "purged")).toHaveLength(pcm.length / 32_000);
        await current.controller.deactivate(); store.close(); store = await DurableDesktopRecordStore.open(options);
        const key = await new DurableDesktopFlowStore(store.namespace("flow")).playbackKey(session.id, store.namespace(`playback-key:${session.id}`));
        expect(key!.extractable).toBe(false); expect(key!.usages).toEqual(["decrypt"]);
        const archive = store.namespace(`playback:${session.id}`), duration = pcm.length / 32;
        const full = await passageWav(archive, session.id, key!, 0, duration, () => undefined);
        expect(full).not.toBeNull(); expect(digest(full!.subarray(44))).toBe(digest(pcm)); full!.fill(0);
        // This excerpt crosses encrypted chunk boundaries and both spoken turns.
        const excerpt = await passageWav(archive, session.id, key!, 500, duration - 500, () => undefined);
        expect(digest(excerpt!.subarray(44))).toBe(digest(pcm.subarray(16_000, pcm.length - 16_000))); excerpt!.fill(0);
      } finally {
        for (const controller of controllers) await controller.deactivate().catch(() => undefined);
        pcm.fill(0); store.close();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    });
});
