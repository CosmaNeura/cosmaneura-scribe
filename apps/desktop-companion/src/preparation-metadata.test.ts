import { describe, expect, it, vi } from "vitest";
import { DesktopPreparationBff } from "./preparation-metadata.js";
import { CoreCaptureClient } from "../../capture/src/provider/core-client";

const sessionId = "30000000-0000-4000-8000-000000000003";
const scope = { workspaceId: "10000000-0000-4000-8000-000000000001",
  appointmentRef: "appointment_01j00000000000000000000000", bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
const kinds = ["creator_review", "encryption_key", "capabilities"] as const;
type Kind = typeof kinds[number];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function fixture(fault?: Kind | "foreign_review" | "malformed_review") {
  const abort = new AbortController(), gates = Object.fromEntries(kinds.map(kind => [kind, deferred()])) as Record<Kind, ReturnType<typeof deferred>>;
  const review = { schema_version: "1.0", session_id: sessionId, status: "created", source: null,
    working: null, review_queue: null, translation_progress: [] };
  const key = { algorithm: "RSA-OAEP-256", key_version: "synthetic-current-public-version",
    public_jwk: { kty: "RSA", n: "synthetic-public-modulus", e: "AQAB" } };
  const capabilities = { protocol_version: "1.0", max_chunks: 1000 };
  const receipts = { creator_review: review, encryption_key: key, capabilities };
  const request = vi.fn(async (path: string, body: Readonly<Record<string, unknown>>, _key: string, signal: AbortSignal) => {
    expect(path).toBe("/service/v1/agent/scribe/capture-operations"); expect(signal).toBe(abort.signal);
    expect(body.workspace_id).toBe(scope.workspaceId); expect(body.binding_ref).toBe(scope.bindingRef);
    const kind = (body.operation as { kind: Kind }).kind;
    await gates[kind].promise;
    if (fault === kind) return new Response(null, { status: 403 });
    const receipt = kind === "creator_review" && fault === "foreign_review" ? { ...review, session_id: crypto.randomUUID() }
      : kind === "creator_review" && fault === "malformed_review" ? { ...review, status: "invented-invalid-status" } : receipts[kind];
    return Response.json({ contract_version: "1", binding_ref: body.binding_ref, workspace_id: body.workspace_id,
      request_nonce: body.request_nonce, checked_at: new Date().toISOString(), operation: kind, receipt });
  });
  const bff = new DesktopPreparationBff(new CoreCaptureClient(scope, request, abort.signal), sessionId);
  return { bff, request, abort, gates, key, capabilities };
}

describe("fresh desktop preparation metadata", () => {
  it.each(kinds)("overlaps authenticated reads but waits for %s, consuming each result only once", async last => {
    const f = fixture(); let settled = false;
    const preparation = f.bff.authorizePreparation(true).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3));
    expect(f.request.mock.calls.map(call => (call[1].operation as { kind: string }).kind).sort()).toEqual([...kinds].sort());
    expect(new Set(f.request.mock.calls.map(call => call[2])).size).toBe(3);
    for (const kind of kinds) if (kind !== last) f.gates[kind].resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
    f.gates[last].resolve(); expect(await preparation).toEqual({ sessionId, status: "created" });
    expect(await f.bff.getAudioEncryptionKey()).toEqual(f.key);
    expect(await f.bff.getCapabilities(sessionId)).toEqual(f.capabilities);
    expect(f.request).toHaveBeenCalledTimes(3);
    await f.bff.getAudioEncryptionKey(); await f.bff.getCapabilities(sessionId);
    expect(f.request).toHaveBeenCalledTimes(5); // Subsequent operations always call Core again.
    await expect(f.bff.authorizePreparation(true)).rejects.toThrow();
  });

  it.each([...kinds, "foreign_review", "malformed_review"] as const)("settles every read after %s without retaining metadata", async fault => {
    const f = fixture(fault); let settled = false;
    const preparation = f.bff.authorizePreparation(true).catch(error => { settled = true; throw error; });
    const rejection = expect(preparation).rejects.toThrow();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3));
    f.gates.creator_review.resolve(); f.gates.encryption_key.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
    f.gates.capabilities.resolve(); await rejection;
    const retry = f.bff.getCapabilities(sessionId).catch(() => undefined); await retry;
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it("clears metadata on revocation and rejects cancelled consumption without I/O", async () => {
    const f = fixture(), preparation = f.bff.authorizePreparation(true);
    for (const kind of kinds) f.gates[kind].resolve();
    await preparation; f.abort.abort();
    await expect(f.bff.getAudioEncryptionKey()).rejects.toThrow();
    await expect(f.bff.getCapabilities(sessionId)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it("does not publish metadata when revoked during pending reads", async () => {
    const f = fixture(), preparation = f.bff.authorizePreparation(true);
    const rejection = expect(preparation).rejects.toThrow();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(3)); f.abort.abort();
    for (const kind of kinds) f.gates[kind].resolve();
    await rejection; await expect(f.bff.getAudioEncryptionKey()).rejects.toThrow();
  });

  it("keeps retained recovery serial and does not prefetch a key or capabilities", async () => {
    const f = fixture(); const preparation = f.bff.authorizePreparation(false);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce()); f.gates.creator_review.resolve();
    await preparation; expect(f.request).toHaveBeenCalledOnce();
    const read = f.bff.getAudioEncryptionKey(); f.gates.encryption_key.resolve(); await read;
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("refuses a foreign session and clears metadata after a cancelled consumer", async () => {
    const f = fixture(); const preparation = f.bff.authorizePreparation(true);
    for (const kind of kinds) f.gates[kind].resolve(); await preparation;
    await expect(f.bff.getCapabilities(crypto.randomUUID())).rejects.toThrow();
    const consumer = new AbortController(); consumer.abort();
    await expect(f.bff.getAudioEncryptionKey({ signal: consumer.signal })).rejects.toThrow();
    await f.bff.getAudioEncryptionKey(); expect(f.request).toHaveBeenCalledTimes(4);
  });
});
