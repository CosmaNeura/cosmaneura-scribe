import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { base64UrlDecode, decodeEnvelope } from "@cosmaneura-scribe/capture-protocol";
import { DesktopPcmCaptureSource } from "./pcm-capture-source.js";
import type { DesktopPCMCoverage, DesktopPCMDriver, DesktopPCMDriverSession, DesktopPCMPacket,
  DesktopPCMStart, DesktopPCMCompletion } from "./native-pcm-driver.js";
import type { CaptureCapabilities } from "../../capture/src/bff/contracts";
import { HttpCaptureBff } from "../../capture/src/bff/http-client";
import { HttpCiphertextUploadTarget } from "../../capture/src/bff/upload-target";
import { BffCaptureQueueTransport } from "../../capture/src/bff/queue-transport";
import { CaptureFlowController } from "../../capture/src/flow/controller";
import { EncryptedIndexedDbFlowStore } from "../../capture/src/flow/encrypted-store";
import { EncryptedIndexedDbQueueStorage } from "../../capture/src/storage/encrypted-indexeddb";
import { CaptureQueue } from "../../capture/src/queue/capture-queue";
import { createMockBffServer } from "../../capture/src/mock-bff/server";
import { QueueInvariantError } from "../../capture/src/queue/errors";
import type { RuntimeDiagnostic } from "./runtime-diagnostics.js";

const CRYPTO = webcrypto as unknown as Crypto;
const CONSENT = Object.freeze({ id: "desktop-pcm-invented-consent", allPartiesAgreed: true });
const START: DesktopPCMStart = Object.freeze({ hostTimeNanoseconds: "1000000000",
  microphonePrerollNanoseconds: "2500000", systemPrerollNanoseconds: "0" });
const capabilities: CaptureCapabilities = {
  protocol_version: "1.0", media: { media_type: "audio/wav", encoding: "pcm_s16le", channels: 1, sample_rate_hz: 16_000 },
  target_chunk_duration_ms: 20, max_envelope_bytes: 1024, max_chunks: 10, remaining_aggregate_plaintext_bytes: 10240,
  capture_lease_ttl_seconds: 30, reservation_window_seconds: 30, max_reservations_per_batch: 10, upload_concurrency: 1,
};

/** Explicit offline native driver. It never invokes a source, permission or app. */
class Driver implements DesktopPCMDriver {
  readonly checksAvailabilityOnStart?: true;
  constructor(checksAvailabilityOnStart = false) {
    if (checksAvailabilityOnStart) this.checksAvailabilityOnStart = true;
  }
  startCalls = 0;
  active = false;
  frames = 0;
  failStops = 0;
  failActivation = false;
  tail: number[] = [];
  modes: Array<"drain" | "discard"> = [];
  sink?: Parameters<DesktopPCMDriver["start"]>[1];
  ready = Promise.resolve(START);
  stopOverride?: (mode: "drain" | "discard") => Promise<DesktopPCMCompletion | null>;
  getAvailability(): Promise<boolean> { return Promise.resolve(true); }
  start(_configuration: Parameters<DesktopPCMDriver["start"]>[0], sink: Parameters<DesktopPCMDriver["start"]>[1]): DesktopPCMDriverSession {
    expect(CONSENT.allPartiesAgreed).toBe(true);
    this.startCalls++; this.sink = sink; this.frames = 0;
    return { ready: this.ready, activate: () => {
      this.active = true;
      if (this.failActivation) sink.onFailure("failed");
    }, stop: async ({ mode }) => {
      this.modes.push(mode);
      if (this.failStops-- > 0) throw new Error("invented unconfirmed native stop");
      if (this.stopOverride) return this.stopOverride(mode);
      if (mode === "drain" && this.tail.length) { const tail = this.tail; this.tail = []; await this.emit(tail); }
      this.active = false;
      return mode === "discard" ? null : this.completion();
    } };
  }
  completion(): DesktopPCMCompletion {
    return { start: START, outputFrames: this.frames,
      endHostTimeNanoseconds: String(BigInt(START.hostTimeNanoseconds) + BigInt(this.frames) * 62_500n),
      microphoneTailNanoseconds: "1000000", systemTailNanoseconds: "0" };
  }
  async emit(values: readonly number[]): Promise<Uint8Array<ArrayBuffer>> {
    expect(CONSENT.allPartiesAgreed && this.active).toBe(true);
    const bytes = new Uint8Array(values.length * 2), view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt16(index * 2, value, true));
    const packet = { firstFrame: this.frames, pcmBytes: bytes };
    this.frames += values.length;
    await this.sink!.onPcmPacket(packet);
    return bytes;
  }
}

function fixture(persist?: (coverage: DesktopPCMCoverage) => Promise<void>, nativeAvailability = false) {
  const driver = new Driver(nativeAvailability), coverage: DesktopPCMCoverage[] = [];
  const captured: number[] = [];
  const source = new DesktopPcmCaptureSource(driver, persist ?? (async value => { coverage.push(value); }),
    undefined, frames => { captured.push(frames); });
  return { driver, coverage, source, captured };
}

describe("trusted desktop PCM capture", () => {
  it.each([
    [new QueueInvariantError("chunk_not_reserved"), "audio_chunk_commit_failed"],
    [new Error("synthetic private exception text"), "audio_chunk_commit_failed"],
  ] as const)("records fixed commit-failure categories and clears rejected audio", async (failure, event) => {
    const driver = new Driver(), events: Array<[string, number | undefined]> = [];
    const diagnostics: RuntimeDiagnostic = (name, duration) => { events.push([name, duration]); };
    const source = new DesktopPcmCaptureSource(driver, async () => undefined, undefined, undefined, undefined, diagnostics);
    await source.start({ capabilities, onChunk: async () => { throw failure; } });
    await expect(driver.emit(Array(320).fill(123))).rejects.toThrow();
    await source.stop();
    expect(events.map(([name]) => name)).toEqual([event, "audio_chunk_commit"]);
    expect(events[1]![1]).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("synthetic private exception text");
    expect(driver.active).toBe(false);
  });

  it("isolates diagnostic failure from successful commit and native drain", async () => {
    const driver = new Driver(), chunks = vi.fn(async () => undefined);
    const source = new DesktopPcmCaptureSource(driver, async () => undefined, undefined, undefined, undefined,
      () => { throw new Error("synthetic observer failure"); });
    await source.start({ capabilities, onChunk: chunks });
    const bytes = await driver.emit(Array(320).fill(123));
    expect(bytes.every(byte => byte === 0)).toBe(true);
    await source.stop();
    expect(chunks).toHaveBeenCalledOnce();
    expect(driver.modes).toEqual(["drain"]);
  });

  it("keeps separate permission denial before start for drivers without a native guard", async () => {
    const f = fixture(), availability = vi.spyOn(f.driver, "getAvailability").mockResolvedValue(false);
    await expect(f.source.start({ capabilities, onChunk: async () => undefined })).rejects.toThrow();
    expect(availability).toHaveBeenCalledOnce(); expect(f.driver.startCalls).toBe(0);
    expect(f.coverage).toEqual([]);
  });

  it("owns native permission denial through readiness without activation, coverage or packets", async () => {
    const f = fixture(undefined, true), gate = deferred<DesktopPCMStart>();
    const availability = vi.spyOn(f.driver, "getAvailability"), chunks = vi.fn(async () => undefined);
    f.driver.ready = gate.promise;
    const starting = f.source.start({ capabilities, onChunk: chunks });
    const rejected = expect(starting).rejects.toThrow();
    gate.reject(new Error("synthetic native permission denied")); await rejected;
    expect(availability).not.toHaveBeenCalled(); expect(f.driver.startCalls).toBe(1);
    expect(f.driver.active).toBe(false); expect(f.driver.modes).toEqual(["discard"]);
    expect(f.coverage).toEqual([]); expect(chunks).not.toHaveBeenCalled();
  });

  it("cancels an owned native availability wait and never activates its late ready result", async () => {
    const f = fixture(undefined, true), gate = deferred<DesktopPCMStart>();
    const chunks = vi.fn(async () => undefined), abort = new AbortController();
    f.driver.ready = gate.promise;
    const starting = f.source.start({ capabilities, signal: abort.signal, onChunk: chunks });
    const rejected = expect(starting).rejects.toThrow();
    abort.abort(); await rejected;
    gate.resolve(START); await Promise.resolve(); await f.source.stop();
    expect(f.driver.active).toBe(false); expect(f.driver.modes).toContain("discard");
    expect(f.coverage).toEqual([]); expect(chunks).not.toHaveBeenCalled();
  });

  it("reports accepted mixed frames before ten-second commits, freezes, and drains actual tail", async () => {
    const { driver, source, captured } = fixture(), chunks = vi.fn(async () => undefined);
    const long = { ...capabilities, target_chunk_duration_ms: 10_000, max_envelope_bytes: 321_000,
      remaining_aggregate_plaintext_bytes: 3_210_000 };
    await source.start({ capabilities: long, onChunk: chunks });
    for (let i = 0; i < 4; i++) await driver.emit(Array<number>(4_000).fill(0));
    expect(captured).toEqual([4_000, 8_000, 12_000, 16_000]);
    expect(chunks).not.toHaveBeenCalled();
    await Promise.resolve(); expect(captured.at(-1)).toBe(16_000);
    driver.tail = [1, 2, 3]; await source.stop();
    expect(captured.at(-1)).toBe(16_003); expect(chunks).toHaveBeenCalledOnce();
    await source.start({ capabilities: long, onChunk: chunks });
    await driver.emit([1, 2]); expect(captured.at(-1)).toBe(2);
    await source.stop();
  });

  it("does not report successful startup after a synchronous native activation failure", async () => {
    const { driver, source } = fixture(); driver.failActivation = true;
    await expect(source.start({ capabilities, onChunk: async () => undefined })).rejects.toThrow();
    await source.stop(); expect(driver.active).toBe(false); expect(driver.modes).toEqual(["discard"]);
  });
  it("waits for common-start retention, then joins packets and drains full and partial WAV chunks", async () => {
    const gate = deferred<void>(), coverage: DesktopPCMCoverage[] = [];
    const { driver, source } = fixture(async value => { coverage.push(value); if (value.phase === "started") await gate.promise; });
    const waves: Uint8Array[] = [], references: Uint8Array[] = [];
    const starting = source.start({ capabilities, onChunk: async chunk => {
      references.push(chunk.wavBytes); waves.push(chunk.wavBytes.slice());
    } });
    await vi.waitFor(() => expect(coverage).toHaveLength(1));
    expect(driver.active).toBe(false); gate.resolve(); await starting;
    expect(source.channel).toBe("mixed");
    const a = await driver.emit(Array<number>(100).fill(4096));
    const b = await driver.emit(Array<number>(100).fill(-4096));
    expect(waves).toHaveLength(0);
    driver.tail = Array<number>(500).fill(8192);
    await source.stop();
    expect(waves.map(wave => wave.length)).toEqual([684, 684, 164]);
    expect(readPCM(waves[0]!)).toEqual([...Array<number>(100).fill(4096), ...Array<number>(100).fill(-4096), ...Array<number>(120).fill(8192)]);
    expect(references.every(bytes => bytes.every(v => v === 0))).toBe(true);
    expect(a.every(v => v === 0) && b.every(v => v === 0)).toBe(true);
    expect(coverage[1]).toEqual({ phase: "stopped", value: driver.completion() });
    expect(driver.modes).toEqual(["drain"]);
  });

  it("holds native acknowledgement until WAV persistence completes", async () => {
    const { driver, source } = fixture(), gate = deferred<void>();
    let entered = false, acknowledged = false;
    await source.start({ capabilities, onChunk: async () => { entered = true; await gate.promise; } });
    const packet = driver.emit(Array<number>(320).fill(1)).then(() => { acknowledged = true; });
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(acknowledged).toBe(false); gate.resolve(); await packet;
    await driver.emit([2]); await source.stop();
    expect(acknowledged).toBe(true);
  });

  it("retains the native handle after unconfirmed stop and retries with discard", async () => {
    const { driver, source, coverage } = fixture();
    const chunks = vi.fn(async () => undefined);
    await source.start({ capabilities, onChunk: chunks });
    await driver.emit(Array<number>(320).fill(5)); await driver.emit([6, 7]);
    driver.failStops = 1;
    await expect(source.stop()).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });
    await expect(source.start({ capabilities, onChunk: chunks })).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });
    await source.stop();
    expect(driver.modes).toEqual(["drain", "discard"]);
    expect(driver.startCalls).toBe(1); expect(chunks).toHaveBeenCalledTimes(1);
    expect(coverage.map(c => c.phase)).toEqual(["started"]);
  });

  it("accepts confirmed discard when an earlier drain rejects during cancellation", async () => {
    const { driver, source } = fixture(), gate = deferred<DesktopPCMCompletion | null>();
    const abort = new AbortController();
    await source.start({ capabilities, signal: abort.signal, onChunk: async () => undefined });
    await driver.emit([1, 2]);
    driver.stopOverride = async mode => {
      if (mode === "drain") return gate.promise;
      driver.active = false; gate.reject(new Error("invented superseded drain")); return null;
    };
    const closing = source.stop();
    await vi.waitFor(() => expect(driver.modes).toEqual(["drain"]));
    abort.abort(); await closing;
    expect(driver.modes).toEqual(["drain", "discard"]); expect(driver.active).toBe(false);
  });

  it.each(["sequence", "alias", "oversize"])("rejects %s native packets and clears them", async kind => {
    const { driver, source, captured } = fixture(), failed = vi.fn();
    await source.start({ capabilities, onChunk: async () => undefined, onError: failed });
    const backing = new Uint8Array(kind === "oversize" ? 8194 : 8); backing.fill(11);
    const packet: DesktopPCMPacket = { firstFrame: kind === "sequence" ? 1 : 0,
      pcmBytes: kind === "alias" ? backing.subarray(2) : backing };
    await expect(driver.sink!.onPcmPacket(packet)).rejects.toThrow(); await source.stop();
    expect(backing.every(v => v === 0)).toBe(true); expect(failed).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([]);
    expect(driver.modes.every(mode => mode === "discard")).toBe(true);
  });

  it("refuses inconsistent coverage and retains encrypted work for cleanup", async () => {
    const { driver, source } = fixture();
    await source.start({ capabilities, onChunk: async () => undefined });
    await driver.emit([1, 2]);
    driver.stopOverride = async mode => mode === "discard" ? null : { ...driver.completion(), outputFrames: 3 };
    await expect(source.stop()).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });
    await source.stop(); expect(driver.modes).toEqual(["drain", "discard"]);
  });

  it("never activates a cancelled startup or constructs in a renderer", async () => {
    const { driver, source } = fixture(), ready = deferred<DesktopPCMStart>(), abort = new AbortController();
    driver.ready = ready.promise;
    const starting = source.start({ capabilities, signal: abort.signal, onChunk: async () => undefined });
    const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(driver.startCalls).toBe(1));
    abort.abort(); await rejected; await source.stop(); ready.resolve(START);
    expect(driver.active).toBe(false);
    vi.stubGlobal("window", {});
    try { expect(() => fixture()).toThrow("audio_capture_unavailable"); }
    finally { vi.unstubAllGlobals(); }
  });

  it("uses the real flow encryption, retained mixed queue and HTTP upload recovery in Node", async () => {
    const server = createMockBffServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bff = new HttpCaptureBff((input, init) => fetch(typeof input === "string" ? new URL(input, origin) : input, init));
    const database = new IDBFactory(), flowName = CRYPTO.randomUUID(), queueName = CRYPTO.randomUUID();
    let flow = await EncryptedIndexedDbFlowStore.open({ databaseName: flowName, indexedDB: database, crypto: CRYPTO });
    let queue = await EncryptedIndexedDbQueueStorage.open({ databaseName: queueName, indexedDB: database, crypto: CRYPTO });
    const { source, driver } = fixture();
    const controllers: CaptureFlowController[] = [];
    const make = (captureSource: DesktopPcmCaptureSource): CaptureFlowController => {
      const controller = new CaptureFlowController({ bff, flowStore: flow, queue: new CaptureQueue(queue, { crypto: CRYPTO }),
        source: captureSource, crypto: CRYPTO, queueTransport: new BffCaptureQueueTransport(bff, new HttpCiphertextUploadTarget([origin])) });
      controllers.push(controller); return controller;
    };
    try {
      const rsa = await CRYPTO.subtle.generateKey({ name: "RSA-OAEP", hash: "SHA-256", modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]) }, true, ["wrapKey", "unwrapKey"]);
      const original = await bff.getAudioEncryptionKey(), jwk = await CRYPTO.subtle.exportKey("jwk", rsa.publicKey);
      vi.spyOn(bff, "getAudioEncryptionKey").mockResolvedValue({ ...original, public_jwk: {
        kty: "RSA", alg: "RSA-OAEP-256", e: "AQAB", n: jwk.n!, ext: true, key_ops: ["wrapKey"],
      } });
      const person = { appointment_id: "invented-desktop-appointment", practitioner_id: "invented-creator", patient_id: "invented-patient" };
      const consent = await bff.createConsent({ ...person, participant_regions: ["US-NY"], modality: "in_person",
        method: "verbal_attestation", all_parties_consented: CONSENT.allPartiesAgreed, granted_at: new Date().toISOString() },
      { idempotencyKey: "desktop-invented-consent-v1" });
      const session = await bff.createSession({ ...person, consent_record_id: consent.id, modality: "in_person" },
        { idempotencyKey: "desktop-invented-session-v1" });
      const complete = vi.spyOn(bff, "completeCapture"), current = make(source);
      await current.prepareConfigured(session.id); expect(driver.startCalls).toBe(0);
      await current.startRecording();
      for (let count = 0; count < 160_000; count += 4000) await driver.emit(Array<number>(4000).fill(4096));
      await current.deactivate();
      expect(complete).not.toHaveBeenCalled();
      const encrypted = (await queue.list()).find(record => record.state === "encrypted");
      expect(encrypted?.state).toBe("encrypted"); if (!encrypted || encrypted.state !== "encrypted") throw new Error("missing ciphertext");
      expect(encrypted.reservation.channel).toBe("mixed");
      const keyState = (await flow.getSessionKeyState(session.id))!;
      const dek = await CRYPTO.subtle.unwrapKey("raw", owned(base64UrlDecode(keyState.wrappedDek)), rsa.privateKey,
        { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      const envelope = decodeEnvelope(encrypted.envelope);
      const wav = new Uint8Array(await CRYPTO.subtle.decrypt({ name: "AES-GCM", iv: owned(base64UrlDecode(envelope.header.nonce)),
        additionalData: owned(base64UrlDecode(encrypted.reservation.additionalAuthenticatedData)) }, dek, owned(envelope.ciphertext)));
      expect(wav.length).toBe(320_044); expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
      expect(readPCM(wav).every(value => value === 4096)).toBe(true); wav.fill(0);
      expect((await flow.getActiveCaptureState())?.phase).toBe("paused");
      flow.close(); queue.close();
      flow = await EncryptedIndexedDbFlowStore.open({ databaseName: flowName, indexedDB: database, crypto: CRYPTO });
      queue = await EncryptedIndexedDbQueueStorage.open({ databaseName: queueName, indexedDB: database, crypto: CRYPTO });
      const recovered = fixture(), reopened = make(recovered.source);
      expect(await reopened.restore()).toBe(true); expect(recovered.driver.startCalls).toBe(0);
      await reopened.stopRecording();
      expect(reopened.snapshot.state).toBe("processing"); expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]![1].channels).toEqual([{ channel: "mixed", final_sequence_number: 0 }]);
    } finally {
      for (const controller of controllers) await controller.deactivate().catch(() => undefined);
      flow.close(); queue.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

function owned(input: Uint8Array): Uint8Array<ArrayBuffer> { return new Uint8Array(input); }
function readPCM(wav: Uint8Array): number[] {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  return Array.from({ length: (wav.byteLength - 44) / 2 }, (_, index) => view.getInt16(44 + index * 2, true));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
