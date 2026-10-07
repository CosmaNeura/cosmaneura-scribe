import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { base64UrlEncode, encodeChunkAdditionalDataBase64Url, encodeEnvelope } from "@cosmaneura-scribe/capture-protocol";
import { attachEncryptedEnvelope, createReservedRecord } from "../../capture/src/queue/records";
import { encodePcm16MonoWav } from "../../capture/src/capture/wav";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import { passageWav, retainPassageAudio } from "./passage-playback.js";

it("plays bounded authenticated audio and rejects missing frames, revocation and wrong custody", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-playback-")));
  const sessionId = crypto.randomUUID(), tenantId = crypto.randomUUID();
  const master = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  const store = await DurableDesktopRecordStore.open({ directory, workspaceId: crypto.randomUUID(), recoveryScope: tenantId, key: master });
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const encryption = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const decryption = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]); raw.fill(0);
  try {
    const archive = store.namespace(`playback:${sessionId}`);
    for (let sequenceNumber = 0; sequenceNumber < 3; sequenceNumber++) {
      const objectId = crypto.randomUUID();
      const reserved = createReservedRecord({ protocolVersion: "1.0", sessionId, objectId, channel: "mixed", sequenceNumber,
        createdAt: new Date().toISOString(), additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({ sessionId, objectId, tenantId, sequenceNumber, channel: "mixed" }) },
      { reservation: "invented-reservation", uploadAuthorization: "invented-upload", uploadAuthorizationGeneration: 1, registration: "invented-registration" });
      const samples = new Int16Array(16_000).fill(sequenceNumber * 1000 + 500);
      const wav = encodePcm16MonoWav(samples, { sampleRateHz: 16_000, channels: 1, targetChunkDurationMs: 1000, maxEnvelopeBytes: 327_680 }); samples.fill(0);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new Uint8Array(Buffer.from(reserved.reservation.additionalAuthenticatedData, "base64url")) }, encryption, wav); wav.fill(0);
      const envelope = encodeEnvelope({ schema_version: "1.0", content_encryption: "A256GCM", media_type: "audio/wav", nonce: base64UrlEncode(nonce) }, new Uint8Array(encrypted));
      const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(envelope))).toString("hex");
      const record = attachEncryptedEnvelope(reserved, envelope, digest);
      await retainPassageAudio(archive, record); await retainPassageAudio(archive, record); envelope.fill(0);
    }
    const result = await passageWav(archive, sessionId, decryption, 1500, 2500, () => undefined);
    expect(result?.length).toBe(32_044);
    const view = new DataView(result!.buffer);
    expect(view.getInt16(44, true)).toBe(1500); expect(view.getInt16(44 + 8000 * 2, true)).toBe(2500); result!.fill(0);
    expect(await passageWav(archive, sessionId, decryption, 0, 4000, () => undefined)).toBeNull();
    await expect(passageWav(archive, sessionId, decryption, 0, 30_001, () => undefined)).rejects.toThrow();
    await expect(passageWav(archive, sessionId, decryption, 0, 1000, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    const wrong = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    await expect(passageWav(archive, sessionId, wrong, 1000, 2000, () => undefined)).rejects.toThrow();
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
