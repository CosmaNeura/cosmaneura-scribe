import { describe, expect, it, vi } from "vitest";
import { CoreCaptureClient } from "../../capture/src/provider/core-client";
import { DesktopPreparationBff } from "./preparation-metadata.js";

const sessionId = "30000000-0000-4000-8000-000000000003";
const scope = { workspaceId: "10000000-0000-4000-8000-000000000001",
  appointmentRef: "appointment_01j00000000000000000000000", bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
function fixture(fault?: string) {
  const abort = new AbortController(); let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const review = { schema_version: "1.0", session_id: sessionId, status: "created", source: null,
    working: null, review_queue: null, translation_progress: [] };
  const key = { algorithm: "RSA-OAEP-256", key_version: "synthetic-key",
    public_jwk: { kty: "RSA", n: "a".repeat(512), e: "AQAB", alg: "RSA-OAEP-256", ext: true, key_ops: ["wrapKey"] } };
  const capabilities = { protocol_version: "1.0", media: { media_type: "audio/wav", encoding: "pcm_s16le", channels: 1,
    sample_rate_hz: 16000 }, target_chunk_duration_ms: 10000, max_envelope_bytes: 327680, max_chunks: 1000,
    remaining_aggregate_plaintext_bytes: 67108864, capture_lease_ttl_seconds: 900, reservation_window_seconds: 900,
    max_reservations_per_batch: 90, upload_concurrency: 2 };
  const request = vi.fn(async (path: string, body: Readonly<Record<string, unknown>>, _key: string, signal: AbortSignal) => {
    expect(path).toBe("/service/v1/agent/scribe/capture-operations");
    expect(body.workspace_id).toBe(scope.workspaceId); expect(body.binding_ref).toBe(scope.bindingRef);
    expect(signal.aborted).toBe(false); await gate;
    const kind = (body.operation as { kind: string }).kind;
    if (fault === "denied" && kind === "preparation_metadata") return new Response(null, { status: 403 });
    const combined: Record<string, unknown> = { schema_version: "1.0", review, encryption_key: key, capabilities };
    if (fault === "foreign_review") combined.review = { ...review, session_id: crypto.randomUUID() };
    if (fault === "malformed_review") combined.review = { ...review, status: "invented-invalid-status" };
    if (fault === "missing") delete combined.capabilities;
    if (fault === "extra") combined.capture_permission = true;
    if (fault === "private_key") combined.encryption_key = { ...key, public_jwk: { ...key.public_jwk, d: "invented" } };
    if (fault === "budget") combined.capabilities = { ...capabilities, remaining_aggregate_plaintext_bytes: -1 };
    const receipts: Record<string, unknown> = { creator_review: review, encryption_key: key, capabilities, preparation_metadata: combined };
    return Response.json({ contract_version: "1", binding_ref: body.binding_ref, workspace_id: body.workspace_id,
      request_nonce: body.request_nonce, checked_at: new Date().toISOString(), operation: kind, receipt: receipts[kind] });
  });
  const bff = new DesktopPreparationBff(new CoreCaptureClient(scope, request, abort.signal), sessionId);
  return { bff, request, abort, resolve, key, capabilities };
}

describe("fresh desktop preparation metadata", () => {
  it("waits for one complete authenticated response and consumes each component only once", async () => {
    const f = fixture(); let settled = false;
    const preparation = f.bff.authorizePreparation(true).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    expect(f.request.mock.calls[0]![1].operation).toEqual({ kind: "preparation_metadata" });
    expect(settled).toBe(false); f.resolve();
    expect(await preparation).toEqual({ sessionId, status: "created" });
    expect(await f.bff.getAudioEncryptionKey()).toEqual(f.key);
    expect(await f.bff.getCapabilities(sessionId)).toEqual(f.capabilities);
    expect(f.request).toHaveBeenCalledOnce();
    await f.bff.getAudioEncryptionKey(); await f.bff.getCapabilities(sessionId);
    expect(f.request).toHaveBeenCalledTimes(3);
    await expect(f.bff.authorizePreparation(true)).rejects.toThrow();
  });
  it.each(["denied", "foreign_review", "malformed_review", "missing", "extra", "private_key", "budget"])(
    "rejects %s without retaining partial metadata", async fault => {
      const f = fixture(fault), preparation = f.bff.authorizePreparation(true);
      const rejection = expect(preparation).rejects.toThrow(); f.resolve(); await rejection;
      await f.bff.getCapabilities(sessionId); expect(f.request).toHaveBeenCalledTimes(2);
    });
  it("clears metadata after revocation and rejects consumption without I/O", async () => {
    const f = fixture(), preparation = f.bff.authorizePreparation(true); f.resolve(); await preparation; f.abort.abort();
    await expect(f.bff.getAudioEncryptionKey()).rejects.toThrow();
    await expect(f.bff.getCapabilities(sessionId)).rejects.toThrow(); expect(f.request).toHaveBeenCalledOnce();
  });
  it("does not publish a late response after cancellation", async () => {
    const f = fixture(), preparation = f.bff.authorizePreparation(true), rejection = expect(preparation).rejects.toThrow();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce()); f.abort.abort(); f.resolve();
    await rejection; await expect(f.bff.getAudioEncryptionKey()).rejects.toThrow();
  });
  it("uses ordinary direct reads for retained recovery", async () => {
    const f = fixture(), preparation = f.bff.authorizePreparation(false); f.resolve(); await preparation;
    expect(f.request.mock.calls[0]![1].operation).toEqual({ kind: "creator_review" });
    await f.bff.getAudioEncryptionKey(); expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("refuses a foreign session and clears metadata after a cancelled consumer", async () => {
    const f = fixture(), preparation = f.bff.authorizePreparation(true); f.resolve(); await preparation;
    await expect(f.bff.getCapabilities(crypto.randomUUID())).rejects.toThrow();
    const consumer = new AbortController(); consumer.abort();
    await expect(f.bff.getAudioEncryptionKey({ signal: consumer.signal })).rejects.toThrow();
    await f.bff.getAudioEncryptionKey(); expect(f.request).toHaveBeenCalledTimes(2);
  });
});
