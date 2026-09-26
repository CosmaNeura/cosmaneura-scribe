import { fork } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { base64UrlDecode, base64UrlEncode, decodeEnvelope, encodeChunkAdditionalDataBase64Url, encodeEnvelope, PROTOCOL_VERSION } from "@cosmaneura-scribe/capture-protocol";
import { attachEncryptedEnvelope, captureChunkMetadata, createReservedRecord } from "../../capture/src/queue/records";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import { DurableDesktopFlowStore } from "./durable-flow-store.js";
import { DurableDesktopQueueStorage } from "./durable-queue-store.js";
import { DurableDesktopCoverage, desktopJournalRecords } from "./durable-provider-records.js";
import { NativeCreatorReviewJournal } from "../../review-ui/src/native-review-journal";
import { NativeProviderWorkspaceJournal } from "../../capture/src/provider/workspace-journal";
import { HttpCaptureBff } from "../../capture/src/bff/http-client";
import { HttpCiphertextUploadTarget } from "../../capture/src/bff/upload-target";
import { BffCaptureQueueTransport } from "../../capture/src/bff/queue-transport";
import { CaptureFlowController } from "../../capture/src/flow/controller";
import { CaptureQueue } from "../../capture/src/queue/capture-queue";
import { createMockBffServer } from "../../capture/src/mock-bff/server";
import { nativePipeFixtureFence } from "./native-pipe-fixture.js";

const crypto = webcrypto as unknown as Crypto;
const recoveryScope = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const helperPath = process.env.SCRIBE_DESKTOP_PIPE_FIXTURE;
async function directory(): Promise<string> { return mkdtemp(join(realpathSync(tmpdir()), "scribe-desktop-store-")); }
async function master(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}

describe("durable desktop capture", () => {
  it("measures the queue volume without changing records and refuses reads after closure", async () => {
    const path = await directory(), key = await master();
    const store = await DurableDesktopRecordStore.open({ directory: path, recoveryScope, workspaceId, key });
    try {
      const records = store.namespace("space-check");
      await records.save("retained", null, new Uint8Array([1, 2, 3]));
      expect(await store.availableBytes()).toBeGreaterThan(0);
      expect(await records.get("retained")).toMatchObject({ revision: 1, data: new Uint8Array([1, 2, 3]) });
      const pending = store.availableBytes(); store.close();
      await expect(pending).rejects.toThrow("desktop_storage_unavailable");
      await expect(store.availableBytes()).rejects.toThrow("desktop_storage_unavailable");
    } finally { store.close(); await rm(path, { recursive: true, force: true }); }
  });

  it("scans encrypted queue metadata without bulk payloads and clears scan buffers on early exit", async () => {
    const path = await directory(), key = await master();
    const store = await DurableDesktopRecordStore.open({ directory: path, recoveryScope, workspaceId, key });
    try {
      const records = store.namespace("queue"), storage = new DurableDesktopQueueStorage(records, attemptId);
      const expected = [];
      const envelope = encodeEnvelope({ schema_version: PROTOCOL_VERSION, content_encryption: "A256GCM",
        nonce: base64UrlEncode(new Uint8Array(12)), media_type: "audio/wav" }, new Uint8Array(320_060));
      for (const sequenceNumber of [2, 0, 1]) {
        const objectId = crypto.randomUUID();
        const reserved = createReservedRecord({ protocolVersion: PROTOCOL_VERSION, objectId, sessionId: attemptId,
          channel: "microphone", sequenceNumber, createdAt: "2026-09-25T12:00:00.000Z",
          additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({ tenantId: recoveryScope, sessionId: attemptId,
            objectId, sequenceNumber, channel: "microphone" }) }, { reservation: "synthetic-reserve-0001",
          uploadAuthorization: "synthetic-upload-0001", uploadAuthorizationGeneration: 1, registration: "synthetic-register-0001" });
        await storage.create(reserved);
        const encrypted = attachEncryptedEnvelope(reserved, envelope, "0".repeat(64));
        await storage.compareAndSwap(objectId, 1, encrypted); expected.push(captureChunkMetadata(encrypted));
      }
      vi.spyOn(records, "list").mockRejectedValue(new Error("bulk payload enumeration forbidden"));
      expect(await storage.listMetadata()).toEqual(expected.sort((a, b) => a.reservation.sequenceNumber - b.reservation.sequenceNumber));
      const scan = records.scan(), first = await scan.next();
      expect(first.done).toBe(false);
      if (first.done) throw new Error("missing fixture record");
      const buffer = first.value.data;
      expect(buffer.some(byte => byte !== 0)).toBe(true);
      await scan.return(undefined);
      expect(buffer.every(byte => byte === 0)).toBe(true);
      const retained = await storage.get(expected[0]!.reservation.objectId);
      expect(retained?.state).toBe("encrypted");
      if (retained?.state !== "encrypted") throw new Error("missing fixture envelope");
      expect(retained.envelope).toEqual(envelope);
      const pending = records.scan(); await pending.next(); store.close();
      await expect(pending.next()).rejects.toThrow("desktop_storage_unavailable");
    } finally { store.close(); await rm(path, { recursive: true, force: true }); }
  });

  it("persists sealed CAS records across connections and refuses wrong keys and corrupted ciphertext", async () => {
    const path = await directory(), key = await master(), options = { directory: path, recoveryScope, workspaceId, key };
    let a = await DurableDesktopRecordStore.open(options), b = await DurableDesktopRecordStore.open(options);
    try {
      const value = new TextEncoder().encode("invented-private-record-marker");
      await a.namespace("flow").save("active", null, value);
      const attempts = await Promise.allSettled([a.namespace("flow").save("active", 1, value), b.namespace("flow").save("active", 1, value)]);
      expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect((await b.namespace("flow").get("active"))?.revision).toBe(2);
      for (const name of await readdir(path)) {
        expect((await stat(join(path, name))).mode & 0o077).toBe(0);
        expect((await readFile(join(path, name))).includes(Buffer.from(value))).toBe(false);
      }
      a.close(); b.close();
      a = await DurableDesktopRecordStore.open(options);
      expect((await a.namespace("flow").get("active"))?.data).toEqual(value);
      await expect(DurableDesktopRecordStore.open({ ...options, key: await master() })).rejects.toThrow();
      b = await DurableDesktopRecordStore.open({ ...options, recoveryScope: attemptId });
      expect(await b.namespace("flow").get("active")).toBeNull();
      b.close(); a.close();
      const filename = createHash("sha256").update(`${recoveryScope}:${workspaceId}`).digest("hex") + ".sqlite";
      const corrupt = new DatabaseSync(join(path, filename));
      corrupt.exec("UPDATE records SET ciphertext=zeroblob(length(ciphertext))"); corrupt.close();
      a = await DurableDesktopRecordStore.open(options);
      await expect(a.namespace("flow").get("active")).rejects.toThrow();
    } finally { a.close(); b.close(); await rm(path, { recursive: true, force: true }); }
  });
  it("refuses renderer use, symlink directories and unknown local storage versions", async () => {
    const path = await directory(), key = await master();
    try {
      const options = { directory: path, recoveryScope, workspaceId, key };
      vi.stubGlobal("window", {});
      await expect(DurableDesktopRecordStore.open(options)).rejects.toThrow(); vi.unstubAllGlobals();
      await symlink(path, join(path, "alias"));
      await expect(DurableDesktopRecordStore.open({ ...options, directory: join(path, "alias") })).rejects.toThrow();
      const store = await DurableDesktopRecordStore.open(options); store.close();
      const name = (await readdir(path)).find(name => name.endsWith(".sqlite"))!;
      const database = new DatabaseSync(join(path, name)); database.exec("PRAGMA user_version=2"); database.close();
      await expect(DurableDesktopRecordStore.open(options)).rejects.toThrow();
    } finally { vi.unstubAllGlobals(); await rm(path, { recursive: true, force: true }); }
  });
  it("reuses creator review/provider journals and retains incomplete coverage after reopening", async () => {
    const path = await directory(), key = await master(), options = { directory: path, recoveryScope, workspaceId, key };
    let store = await DurableDesktopRecordStore.open(options);
    try {
      const scope = { workspaceId, bindingRef: `binding_${"a".repeat(43)}`, appointmentRef: `appointment_${"b".repeat(43)}` };
      const journal = new NativeProviderWorkspaceJournal(desktopJournalRecords(store.namespace("workspace")), recoveryScope, scope);
      const progress = { admission: { key: attemptId, languageMode: "en-US+es-US" as const,
        attestation: { modality: "virtual" as const, participant_regions: ["US-NY"], method: "verbal_attestation" as const,
          all_parties_consented: true as const, granted_at: new Date().toISOString() } }, sessionId: null, uploaded: false, pendingSave: null };
      await journal.save(await journal.load(), progress);
      const review = new NativeCreatorReviewJournal(desktopJournalRecords(store.namespace("review")), recoveryScope, attemptId);
      const decision = { key: "invented-review-operation", request: { schema_version: "1.0" as const, source_segment_id: workspaceId,
        translation_id: attemptId, decision: "accepted" as const, expected_source_segment_version: 1,
        expected_source_transcript_version: 1, expected_translation_version: 1 } };
      await review.save(decision);
      const coverage = new DurableDesktopCoverage(store.namespace("coverage"), attemptId);
      const start = { hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" };
      await coverage.persist({ phase: "started", value: start }); store.close();
      store = await DurableDesktopRecordStore.open(options);
      expect((await new NativeProviderWorkspaceJournal(desktopJournalRecords(store.namespace("workspace")), recoveryScope, scope).load()).progress).toEqual(progress);
      const restored = new NativeCreatorReviewJournal(desktopJournalRecords(store.namespace("review")), recoveryScope, attemptId);
      expect(await restored.load()).toEqual(decision);
      await restored.clear(decision.key); expect(await restored.load()).toBeNull();
      const restoredCoverage = new DurableDesktopCoverage(store.namespace("coverage"), attemptId);
      expect(await restoredCoverage.load()).toEqual({ phase: "started", value: start });
      await expect(restoredCoverage.persist({ phase: "started", value: { ...start, hostTimeNanoseconds: "2" } })).rejects.toThrow();
    } finally { store.close(); await rm(path, { recursive: true, force: true }); }
  });
  it("reopens native coverage after a late long-visit resume", async () => {
    const path = await directory(), key = await master(), options = { directory: path, recoveryScope, workspaceId, key };
    let store = await DurableDesktopRecordStore.open(options);
    try {
      await new DurableDesktopCoverage(store.namespace("coverage"), attemptId).beginInterval(workspaceId, 1080);
      store.close(); store = await DurableDesktopRecordStore.open(options);
      const coverage = new DurableDesktopCoverage(store.namespace("coverage"), attemptId);
      expect(await coverage.load()).toBeNull();
      await coverage.beginInterval(workspaceId, 1080);
      await expect(coverage.beginInterval(recoveryScope, 2048)).rejects.toThrow();
    } finally { store.close(); await rm(path, { recursive: true, force: true }); }
  });

  it("refuses an unprotected session-key candidate instead of persisting an unrecoverable key", async () => {
    const path = await directory(), key = await master();
    const store = await DurableDesktopRecordStore.open({ directory: path, recoveryScope, workspaceId, key });
    try {
      const flow = new DurableDesktopFlowStore(store.namespace("flow"));
      const unprotected = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
      await expect(flow.putSessionKeyCandidate({ schemaVersion: 2, sessionId: attemptId, keyVersion: "invented-v1",
        wrappedDek: "a".repeat(512), idempotencyKey: "invented-key-bind-v1", state: "pending" }, unprotected)).rejects.toThrow();
      expect(await flow.getSessionKeyState(attemptId)).toBeNull();
    } finally { store.close(); await rm(path, { recursive: true, force: true }); }
  });

  it.skipIf(!helperPath)("recovers actual native capture, key and WAL after SIGKILL, then uploads once through the existing flow", async () => {
    if (!helperPath) throw new Error("compiled invented source required");
    const path = await directory(), dataPath = join(path, "data"), raw = new Uint8Array(randomBytes(32));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
    const server = createMockBffServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bff = new HttpCaptureBff((url, init) => fetch(typeof url === "string" ? new URL(url, origin) : url, init));
    let store: DurableDesktopRecordStore | undefined, controller: CaptureFlowController | undefined;
    let child: ReturnType<typeof fork> | undefined, closed: Promise<void> | undefined;
    try {
      const person = { appointment_id: "invented-desktop-appointment", practitioner_id: "invented-creator", patient_id: "invented-patient" };
      const consent = await bff.createConsent({ ...person, participant_regions: ["US-NY"], modality: "in_person", method: "verbal_attestation",
        all_parties_consented: true, granted_at: new Date().toISOString() }, { idempotencyKey: "durable-invented-consent-v1" });
      const session = await bff.createSession({ ...person, consent_record_id: consent.id, modality: "in_person" }, { idempotencyKey: "durable-invented-session-v1" });
      const rsa = await crypto.subtle.generateKey({ name: "RSA-OAEP", hash: "SHA-256", modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]) }, true, ["wrapKey", "unwrapKey"]);
      const original = await bff.getAudioEncryptionKey(), jwk = await crypto.subtle.exportKey("jwk", rsa.publicKey);
      const published = { ...original, public_jwk: { kty: "RSA", alg: "RSA-OAEP-256", e: "AQAB", n: jwk.n!, ext: true, key_ops: ["wrapKey"] } };
      const outfile = join(path, "fixture.mjs");
      await build({ entryPoints: [resolve(import.meta.dirname, "../../../scripts/desktop-native/durable-fixture.mjs")], outfile,
        platform: "node", target: "node24", bundle: true, format: "esm", logLevel: "silent" });
      child = fork(outfile, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", env: {} });
      closed = new Promise<void>(resolve => { child!.once("exit", () => resolve()); });
      const committed = new Promise<unknown>((resolve, reject) => {
        child!.once("error", reject); child!.once("message", resolve);
        child!.once("exit", () => reject(new Error("fixture exited before checkpoint")));
      });
      child.send({ directory: dataPath, rootKey: raw, recoveryScope, workspaceId, sessionId: session.id, attemptId,
        origin, published, consent: "invented-all-parties-agreed", helperPath,
        processFence: nativePipeFixtureFence(),
        helperSha256: createHash("sha256").update(await readFile(helperPath)).digest("hex") });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(await Promise.race([committed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("fixture checkpoint timed out")), 10_000);
        })])).toEqual({ type: "committed", phase: "recording", coverage: "stopped" });
      } finally { clearTimeout(timer); }
      raw.fill(0); child.kill("SIGKILL"); await closed;
      expect(child.signalCode).toBe("SIGKILL");
      store = await DurableDesktopRecordStore.open({ directory: dataPath, recoveryScope, workspaceId, key });
      const flow = new DurableDesktopFlowStore(store.namespace("flow"));
      const queue = new DurableDesktopQueueStorage(store.namespace(`queue:${session.id}`), session.id);
      expect((await flow.getActiveCaptureState())?.phase).toBe("recording");
      const encrypted = (await queue.list()).find(record => record.state === "encrypted");
      if (!encrypted || encrypted.state !== "encrypted") throw new Error("missing retained envelope");
      const state = (await flow.getSessionKeyState(session.id))!;
      const decryptKey = await crypto.subtle.unwrapKey("raw", new Uint8Array(base64UrlDecode(state.wrappedDek)), rsa.privateKey,
        { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      const envelope = decodeEnvelope(encrypted.envelope);
      const wav = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(base64UrlDecode(envelope.header.nonce)),
        additionalData: new Uint8Array(base64UrlDecode(encrypted.reservation.additionalAuthenticatedData)) }, decryptKey, new Uint8Array(envelope.ciphertext)));
      expect(wav.length).toBe(9644);
      const samples = new DataView(wav.buffer); for (let i = 44; i < wav.length; i += 2) expect(samples.getInt16(i, true)).toBe(4096);
      const restoredKey = (await flow.getSessionKey(session.id))!;
      expect(restoredKey.extractable).toBe(false); expect(restoredKey.usages).toEqual(["encrypt"]);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const verification = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, restoredKey, wav);
      expect(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, decryptKey, verification))).toEqual(wav); wav.fill(0);
      const coverage = await new DurableDesktopCoverage(store.namespace(`coverage:${session.id}`), attemptId).load();
      expect(coverage?.phase).toBe("stopped");
      const start = vi.fn(async () => { throw new Error("recovery must not start recording"); });
      const complete = vi.spyOn(bff, "completeCapture");
      controller = new CaptureFlowController({ bff, flowStore: flow, createSessionKey: flow.createSessionKey,
        source: { kind: "microphone", channel: "mixed", start, stop: async () => undefined },
        crypto, queue: new CaptureQueue(queue, { crypto }), queueTransport: new BffCaptureQueueTransport(bff, new HttpCiphertextUploadTarget([origin])) });
      expect(await controller.restore()).toBe(true); expect(controller.snapshot.state).toBe("paused"); expect(start).not.toHaveBeenCalled();
      await controller.stopRecording();
      expect(controller.snapshot.state).toBe("processing"); expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]![1].channels).toEqual([{ channel: "mixed", final_sequence_number: 0 }]);
    } finally {
      raw.fill(0);
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
      await controller?.deactivate(); store?.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(path, { recursive: true, force: true });
    }
  }, 20_000);
});
