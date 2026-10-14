import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopInitialWindowOwner, claimDesktopInitialWindow, type DesktopInitialWindowProof } from "./desktop-initial-window.js";
import type { ConfiguredCapturePreparationState, SessionKeyBindingState } from "../../capture/src/flow/types";

const sessionId = "30000000-0000-4000-8000-000000000003";
const scope = { workspaceId: "10000000-0000-4000-8000-000000000001", appointmentRef: "appointment_01j00000000000000000000000",
  bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const abort = new AbortController();
  const admission = { key: crypto.randomUUID(), nonce: crypto.randomUUID(), receipt: { session_id: sessionId, fixture: "fictional" } };
  const owner = new DesktopInitialWindowOwner(scope, admission, abort.signal);
  const initial: ConfiguredCapturePreparationState = { mode: "configured_core", schemaVersion: 6, channel: "mixed", sessionId,
    startedAt: new Date().toISOString(), completeIdempotencyKey: "complete:" + crypto.randomUUID(), leaseIdempotencyKey: null,
    leaseRequest: null, windowPreparation: null };
  const key: SessionKeyBindingState = { schemaVersion: 2, sessionId, state: "pending", keyVersion: "fixture-key", wrappedDek: "a".repeat(512),
    idempotencyKey: "bind-key:" + crypto.randomUUID() };
  const recipe: ConfiguredCapturePreparationState = { ...initial, leaseIdempotencyKey: "lease:" + crypto.randomUUID(),
    leaseRequest: { protocol_version: "1.0" }, windowPreparation: { idempotencyKey: "prepare-window:" + crypto.randomUUID(),
      bindIdempotencyKey: key.idempotencyKey, reserveIdempotencyKey: "reserve:" + crypto.randomUUID(), keyVersion: key.keyVersion,
      wrappedDek: key.wrappedDek, reservationCount: 30, aggregatePlaintextBudgetBytes: 67108864 } };
  const body = { workspace_id: scope.workspaceId, binding_ref: scope.bindingRef, request_nonce: String(crypto.randomUUID()),
    operation: { kind: "prepare_recording_window", payload: { schema_version: "1.0",
      binding: { key_version: key.keyVersion, wrapped_dek: key.wrappedDek }, bind_idempotency_key: key.idempotencyKey,
      lease_idempotency_key: recipe.leaseIdempotencyKey, reserve_idempotency_key: recipe.windowPreparation!.reserveIdempotencyKey,
      channel: "mixed", reservation_count: 30 } } };
  const dispatch = { scope, body, key: recipe.windowPreparation!.idempotencyKey };
  const ready = () => { owner.preparation(null, initial); owner.newKey(key); owner.preparation(initial, recipe); };
  return { owner, abort, admission, initial, key, recipe, body, dispatch, ready };
}

describe("main-only initial desktop WINDOW witness", () => {
  it("transfers only one proof and consumes it before a duplicate concurrent claim", async () => {
    const f = fixture(); f.ready(); const proof = f.owner.take(f.body, f.dispatch.key)!;
    expect(Object.keys(proof)).toEqual([]); expect(Object.getPrototypeOf(proof)).toBeNull();
    expect(claimDesktopInitialWindow(proof, f.dispatch)).toEqual(f.admission);
    expect(() => claimDesktopInitialWindow(proof, f.dispatch)).toThrow();
    expect(f.owner.take(f.body, f.dispatch.key)).toBeNull();
  });
  it.each(["cast", "prototype", "serialized", "copy"])("rejects a %s lookalike without recreating authority", mode => {
    const f = fixture(); f.ready(); const proof = f.owner.take(f.body, f.dispatch.key)!;
    const forged = mode === "cast" ? {} : mode === "prototype" ? Object.create(proof)
      : mode === "serialized" ? JSON.parse(JSON.stringify(proof)) : { ...proof };
    expect(() => claimDesktopInitialWindow(forged as DesktopInitialWindowProof, f.dispatch)).toThrow();
    expect(claimDesktopInitialWindow(proof, f.dispatch)).toEqual(f.admission);
  });
  it.each(["workspace", "binding", "nonce", "key", "wrapped_key", "channel", "count", "component", "extra"])(
    "does not issue a proof after a %s request mismatch, or replay it afterward", mode => {
      const f = fixture(); f.ready(); const body = structuredClone(f.body); let key = f.dispatch.key;
      if (mode === "workspace") body.workspace_id = crypto.randomUUID();
      if (mode === "binding") body.binding_ref += "x";
      if (mode === "nonce") body.request_nonce = "invalid";
      if (mode === "key") key = "prepare-window:" + crypto.randomUUID();
      if (mode === "wrapped_key") body.operation.payload.binding.wrapped_dek = "b".repeat(512);
      if (mode === "channel") body.operation.payload.channel = "microphone";
      if (mode === "count") body.operation.payload.reservation_count = 1;
      if (mode === "component") body.operation.payload.reserve_idempotency_key = "reserve:" + crypto.randomUUID();
      if (mode === "extra") Object.assign(body.operation.payload, { reuse: true });
      expect(f.owner.take(body, key)).toBeNull(); expect(f.owner.take(f.body, f.dispatch.key)).toBeNull();
    });
  it.each(["no_preparation", "retained_preparation", "no_key", "retained_key", "no_recipe", "thrown_write", "changed_recipe"])(
    "requires exception-free new custody and recipe: %s", mode => {
      const f = fixture();
      if (mode !== "no_preparation") f.owner.preparation(mode === "retained_preparation" ? f.initial : null, f.initial);
      if (mode !== "no_key") f.owner.newKey(mode === "retained_key" ? { ...f.key, state: "bound" } : f.key);
      if (mode !== "no_recipe") f.owner.preparation(f.initial, mode === "changed_recipe" ? { ...f.recipe, startedAt: new Date(0).toISOString() } : f.recipe);
      if (mode === "thrown_write") f.owner.invalidate();
      expect(f.owner.take(f.body, f.dispatch.key)).toBeNull();
    });
  it("revokes a pending and a transferred proof on cancellation", () => {
    const f = fixture(); f.ready(); const proof = f.owner.take(f.body, f.dispatch.key)!; f.abort.abort();
    expect(() => claimDesktopInitialWindow(proof, f.dispatch)).toThrow();
    const g = fixture(); g.ready(); g.abort.abort(); expect(g.owner.take(g.body, g.dispatch.key)).toBeNull();
  });
  it("consumes a proof on a backend dispatch mismatch", () => {
    const f = fixture(); f.ready(); const proof = f.owner.take(f.body, f.dispatch.key)!;
    expect(() => claimDesktopInitialWindow(proof, { ...f.dispatch, key: crypto.randomUUID() })).toThrow();
    expect(() => claimDesktopInitialWindow(proof, f.dispatch)).toThrow();
  });
  it("cannot create or claim a witness in a renderer environment", () => {
    const f = fixture(); f.ready(); const proof = f.owner.take(f.body, f.dispatch.key)!;
    vi.stubGlobal("window", {});
    expect(() => claimDesktopInitialWindow(proof, f.dispatch)).toThrow(); expect(() => fixture()).toThrow();
  });
});
