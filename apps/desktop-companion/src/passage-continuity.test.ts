import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { base64UrlEncode, encodeChunkAdditionalDataBase64Url, encodeEnvelope } from "@cosmaneura-scribe/capture-protocol";
import { attachEncryptedEnvelope, createReservedRecord } from "../../capture/src/queue/records";
import { encodePcm16MonoWav } from "../../capture/src/capture/wav";
import type { CaptureContinuity } from "../../review-ui/src/creator-review-api";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import { passageWav, retainPassageAudio } from "./passage-playback.js";

// Invented, all-party-consented PCM only. The short third chunk models a normal
// pause flush; restart sequence 3 follows it with no invented wall-clock silence.
async function fixture(channel: "mixed" | "microphone" = "mixed") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-passage-restart-")));
  const sessionId = crypto.randomUUID(), tenantId = crypto.randomUUID();
  const master = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  const store = await DurableDesktopRecordStore.open({ directory, workspaceId: crypto.randomUUID(), recoveryScope: tenantId, key: master });
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const encryption = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const decryption = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]); raw.fill(0);
  const archive = store.namespace(`playback:${sessionId}`), frameCounts = [16_000, 16_000, 4_000, 16_000];
  const expected = new Int16Array(frameCounts.reduce((a, b) => a + b, 0)); let offset = 0;
  for (const [sequenceNumber, frames] of frameCounts.entries()) {
    const objectId = crypto.randomUUID();
    const reserved = createReservedRecord({ protocolVersion: "1.0", sessionId, objectId, channel, sequenceNumber,
      createdAt: new Date(Date.UTC(2026, 9, 27, sequenceNumber < 3 ? 10 : 12)).toISOString(),
      additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({ sessionId, objectId, tenantId, sequenceNumber, channel }) },
    { reservation: "invented-reservation", uploadAuthorization: "invented-upload", uploadAuthorizationGeneration: 1, registration: "invented-registration" });
    const samples = new Int16Array(frames).fill(sequenceNumber + 1); expected.set(samples, offset); offset += frames;
    const wav = encodePcm16MonoWav(samples, { sampleRateHz: 16_000, channels: 1, targetChunkDurationMs: frames / 16, maxEnvelopeBytes: 327_680 }); samples.fill(0);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
      additionalData: new Uint8Array(Buffer.from(reserved.reservation.additionalAuthenticatedData, "base64url")) }, encryption, wav); wav.fill(0);
    const envelope = encodeEnvelope({ schema_version: "1.0", content_encryption: "A256GCM", media_type: "audio/wav", nonce: base64UrlEncode(nonce) }, new Uint8Array(encrypted));
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(envelope))).toString("hex");
    await retainPassageAudio(archive, attachEncryptedEnvelope(reserved, envelope, digest)); envelope.fill(0);
  }
  const continuity: CaptureContinuity = { schema_version: "1.0", continuity: "interrupted_or_unconfirmed", missing_audio: "unknown",
    starts: [{ source_start_id: crypto.randomUUID(), first_sequence_number: 0 }, { source_start_id: crypto.randomUUID(), first_sequence_number: 3 }] };
  return { archive, sessionId, decryption, expected, continuity,
    close: async () => { expected.fill(0); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

it.each([[500, 1500], [2000, 2500], [2500, 3000]])("maps authenticated passage %i–%i before, across and after a restart", async (start, end) => {
  const f = await fixture();
  try {
    const warning = structuredClone(f.continuity);
    const wav = await passageWav(f.archive, f.sessionId, f.decryption, start, end, () => undefined, f.continuity);
    expect(wav).not.toBeNull();
    const samples = new Int16Array(wav!.buffer, 44);
    expect(samples).toEqual(f.expected.slice(start * 16, end * 16));
    expect(f.continuity).toEqual(warning); wav!.fill(0);
  } finally { await f.close(); }
});

it.each(["missing_middle", "boundary_after_archive", "malformed", "wrong_channel"])("refuses unproven restart mapping: %s", async kind => {
  const f = await fixture(kind === "wrong_channel" ? "microphone" : "mixed");
  try {
    if (kind === "missing_middle") {
      const row = (await f.archive.get("chunk:2"))!; f.archive.delete(row.key, row.revision); row.data.fill(0);
    }
    if (kind === "boundary_after_archive") f.continuity.starts[1]!.first_sequence_number = 5;
    if (kind === "malformed") f.continuity.starts[1]!.source_start_id = f.continuity.starts[0]!.source_start_id;
    const read = passageWav(f.archive, f.sessionId, f.decryption, 0, 500, () => undefined, f.continuity);
    if (kind === "malformed" || kind === "wrong_channel") await expect(read).rejects.toThrow();
    else expect(await read).toBeNull();
  } finally { await f.close(); }
});
