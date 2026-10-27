import { base64UrlDecode, parseEnvelope } from "@cosmaneura-scribe/capture-protocol";
import { decodeCaptureRecord, encodeCaptureRecord } from "../../capture/src/storage/record-codec";
import type { CaptureChunkRecord } from "../../capture/src/queue/types";
import type { DesktopRecordNamespace } from "./durable-record-store.js";
import { failure } from "./durable-record-store.js";
import { encodePcm16MonoWav } from "../../capture/src/capture/wav";
import { parseCaptureContinuity, type CaptureContinuity } from "../../review-ui/src/creator-review-api";

/** Sealed review copies of immutable envelopes, separate from upload recovery.
 * Original queue purging and confirmed registration remain unchanged. */
export async function retainPassageAudio(archive: DesktopRecordNamespace, record: CaptureChunkRecord): Promise<void> {
  if (record.state !== "encrypted") throw failure();
  const key = `chunk:${record.reservation.sequenceNumber}`, prior = await archive.get(key);
  if (prior) {
    try {
      const saved = decodeCaptureRecord(new TextDecoder().decode(prior.data));
      if (!("sha256" in saved) || saved.sha256 !== record.sha256 || saved.reservation.objectId !== record.reservation.objectId) throw failure();
      return;
    } finally { prior.data.fill(0); }
  }
  const bytes = new TextEncoder().encode(encodeCaptureRecord(record));
  try { await archive.save(key, null, bytes); } finally { bytes.fill(0); }
}

/** Inputs are from a fresh server segment, never a renderer time range. Only
 * up to 30 seconds are decrypted at once. No plaintext touches disk. */
export async function passageWav(archive: DesktopRecordNamespace, sessionId: string, key: CryptoKey, startMs: number, endMs: number,
  current: () => void, continuity?: CaptureContinuity): Promise<Uint8Array<ArrayBuffer> | null> {
  current();
  if (continuity) parseCaptureContinuity(continuity);
  if (key.extractable || key.algorithm.name !== "AES-GCM" || key.usages.length !== 1 || key.usages[0] !== "decrypt"
    || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || endMs - startMs > 30_000) throw failure();
  const startFrame = startMs * 16, endFrame = endMs * 16;
  const parts: Int16Array<ArrayBuffer>[] = []; let position = 0;
  try {
    // Scan clears each outer decrypted record before moving to the next one.
    // Individual audio envelopes are decrypted only until this bounded passage.
    const metadata: { key: string; sequence: number }[] = [];
    for await (const stored of archive.scan()) {
      try {
        current(); if (!stored.key.startsWith("chunk:")) continue;
        const sequence = Number(stored.key.slice(6));
        if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 2048) throw failure();
        if (continuity) {
          const record = decodeCaptureRecord(new TextDecoder().decode(stored.data));
          try {
            if (!("envelope" in record) || record.reservation.sequenceNumber !== sequence
              || record.reservation.sessionId !== sessionId || record.reservation.channel !== "mixed") throw failure();
          } finally { if ("envelope" in record) record.envelope.fill(0); }
        }
        metadata.push({ key: stored.key, sequence });
      } finally { stored.data.fill(0); }
    }
    metadata.sort((a, b) => a.sequence - b.sequence);
    // The server's mixed track concatenates consecutive chunks without inserting
    // wall-clock pause time; its phrase offsets use those same PCM frames. A
    // restart therefore does not move a passage. Require the complete local
    // sequence and every declared boundary, retaining the review's gap warning.
    if (continuity && (!metadata.length || metadata.some((item, index) => item.sequence !== index)
      || continuity.starts.some(start => start.first_sequence_number > metadata.length))) return null;
    for (const [index, item] of metadata.entries()) {
      current(); if (item.sequence !== index) return null;
      const stored = await archive.get(item.key); current(); if (!stored) return null;
      let record: CaptureChunkRecord;
      try { record = decodeCaptureRecord(new TextDecoder().decode(stored.data)); } finally { stored.data.fill(0); }
      if (!("envelope" in record) || record.reservation.sequenceNumber !== item.sequence || record.reservation.sessionId !== sessionId) throw failure();
      const decoded = parseEnvelope(record.envelope);
      const declaredFrames = (decoded.ciphertext.length - 16 - 44) / 2;
      if (!Number.isSafeInteger(declaredFrames) || declaredFrames < 1 || declaredFrames > 160_000) throw failure();
      if (position + declaredFrames <= startFrame) {
        position += declaredFrames; decoded.ciphertext.fill(0); record.envelope.fill(0); continue;
      }
      let wav: Uint8Array<ArrayBuffer> | undefined;
      try {
        wav = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(base64UrlDecode(decoded.header.nonce)),
          additionalData: new Uint8Array(base64UrlDecode(record.reservation.additionalAuthenticatedData)) }, key, new Uint8Array(decoded.ciphertext)));
        current(); const view = new DataView(wav.buffer);
        if (wav.length < 46 || ascii(wav, 0, 4) !== "RIFF" || ascii(wav, 8, 4) !== "WAVE" || ascii(wav, 36, 4) !== "data"
          || view.getUint32(4, true) !== wav.length - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
          || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16_000 || view.getUint16(34, true) !== 16
          || view.getUint32(40, true) !== wav.length - 44 || (wav.length - 44) % 2 !== 0) throw failure();
        const frames = (wav.length - 44) / 2;
        const from = Math.max(startFrame - position, 0), to = Math.min(endFrame - position, frames);
        if (to > from) {
          const part = new Int16Array(to - from);
          for (let i = from; i < to; i++) part[i - from] = view.getInt16(44 + i * 2, true);
          parts.push(part);
        }
        position += frames; if (position >= endFrame) break;
      } finally { wav?.fill(0); decoded.ciphertext.fill(0); record.envelope.fill(0); }
    }
    if (position < endFrame) return null;
    const samples = new Int16Array(endFrame - startFrame); let offset = 0;
    try {
      for (const part of parts) { samples.set(part, offset); offset += part.length; }
      if (offset !== samples.length) return null;
      current(); return encodePcm16MonoWav(samples, { sampleRateHz: 16_000, channels: 1, targetChunkDurationMs: endMs - startMs, maxEnvelopeBytes: 960_044 });
    } finally { samples.fill(0); }
  } finally { parts.forEach(part => part.fill(0)); }
}
function ascii(bytes: Uint8Array, offset: number, count: number): string { return String.fromCharCode(...bytes.subarray(offset, offset + count)); }
