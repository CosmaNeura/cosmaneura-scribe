import type { CapturePreparationState, SessionKeyBindingState } from "../../capture/src/flow/types";
import type { CoreCaptureScope } from "../../capture/src/provider/core-client";
import { canonical } from "../../capture/src/provider/core-notes";

/** Main-only identity capability. No serialized properties or renderer option. */
declare const proofBrand: unique symbol;
export interface DesktopInitialWindowProof { readonly [proofBrand]: true }
type Dispatch = { readonly scope: CoreCaptureScope; readonly body: Readonly<Record<string, unknown>>; readonly key: string };
type Admission = { readonly key: string; readonly nonce: string; readonly receipt: Readonly<Record<string, unknown>> };
const proofs = new WeakMap<object, { dispatch: string; admission: Admission; signal: AbortSignal }>();

export interface DesktopFreshPreparationWitness {
  preparation(prior: CapturePreparationState | null, next: CapturePreparationState): void;
  newKey(state: SessionKeyBindingState): void;
  invalidate(): void;
}

/** Only the trusted factory supplies its clean new-journal/new-store admission.
 * The store reports completed writes; readback after a thrown write is recovery.
 * This is a RAM witness, never a durable format, token or source/audio grant. */
export class DesktopInitialWindowOwner implements DesktopFreshPreparationWitness {
  private live = true;
  private prepared: CapturePreparationState | null = null;
  private key: SessionKeyBindingState | null = null;
  private recipe: CapturePreparationState | null = null;
  private readonly admission: Admission;
  constructor(private readonly scope: CoreCaptureScope, admission: Admission, private readonly signal: AbortSignal) {
    requireMain();
    this.admission = structuredClone(admission);
    signal.addEventListener("abort", () => this.invalidate(), { once: true });
  }
  invalidate(): void { this.live = false; this.prepared = null; this.key = null; this.recipe = null; }
  preparation(prior: CapturePreparationState | null, next: CapturePreparationState): void {
    if (!this.live || this.signal.aborted) { this.invalidate(); return; }
    if (next.mode !== "configured_core" || next.schemaVersion !== 6 || next.channel !== "mixed"
      || next.sessionId !== this.admission.receipt.session_id) { this.invalidate(); return; }
    if (prior === null && this.prepared === null && next.windowPreparation === null
      && next.leaseIdempotencyKey === null && next.leaseRequest === null) {
      this.prepared = structuredClone(next); return;
    }
    if (this.prepared === null || this.recipe !== null || canonical(prior) !== canonical(this.prepared)
      || !next.windowPreparation || !this.key || next.leaseRequest?.protocol_version !== "1.0"
      || typeof next.leaseIdempotencyKey !== "string"
      || next.startedAt !== this.prepared.startedAt || next.completeIdempotencyKey !== this.prepared.completeIdempotencyKey) { this.invalidate(); return; }
    const recipe = next.windowPreparation;
    if (recipe.reservationCount !== 30 || recipe.bindIdempotencyKey !== this.key.idempotencyKey
      || recipe.keyVersion !== this.key.keyVersion || recipe.wrappedDek !== this.key.wrappedDek
      || new Set([recipe.idempotencyKey, recipe.bindIdempotencyKey, next.leaseIdempotencyKey, recipe.reserveIdempotencyKey]).size !== 4) { this.invalidate(); return; }
    this.recipe = structuredClone(next);
  }
  newKey(state: SessionKeyBindingState): void {
    if (!this.live || this.signal.aborted || !this.prepared || this.key || state.state !== "pending"
      || state.sessionId !== this.admission.receipt.session_id) { this.invalidate(); return; }
    this.key = structuredClone(state);
  }
  take(body: Readonly<Record<string, unknown>>, key: string): DesktopInitialWindowProof | null {
    const recipe = this.recipe;
    const eligible = this.live && !this.signal.aborted && recipe?.mode === "configured_core" && recipe.windowPreparation;
    // Destructive claim precedes validation and every async dispatch boundary.
    this.invalidate();
    if (!eligible || !recipe || recipe.mode !== "configured_core" || !recipe.windowPreparation) return null;
    const window = recipe.windowPreparation;
    if (body.workspace_id !== this.scope.workspaceId || body.binding_ref !== this.scope.bindingRef
      || !uuid(body.request_nonce) || Object.keys(body).sort().join(",") !== "binding_ref,operation,request_nonce,workspace_id"
      || key !== window.idempotencyKey || canonical(body.operation) !== canonical({ kind: "prepare_recording_window", payload: {
        schema_version: "1.0", binding: { key_version: window.keyVersion, wrapped_dek: window.wrappedDek },
        bind_idempotency_key: window.bindIdempotencyKey, lease_idempotency_key: recipe.leaseIdempotencyKey,
        reserve_idempotency_key: window.reserveIdempotencyKey, channel: "mixed", reservation_count: 30,
      } })) return null;
    const proof = Object.freeze(Object.create(null)) as DesktopInitialWindowProof;
    proofs.set(proof, { dispatch: canonical({ scope: this.scope, body, key }), admission: this.admission, signal: this.signal });
    return proof;
  }
}

/** Backend consumes the exact main-issued identity before its first await.
 * Casts, copies, prototypes and IPC serialization cannot recreate WeakMap entry. */
export function claimDesktopInitialWindow(proof: DesktopInitialWindowProof, dispatch: Dispatch): Admission {
  requireMain();
  const saved = proofs.get(proof); proofs.delete(proof);
  if (!saved || saved.signal.aborted || saved.dispatch !== canonical(dispatch)) throw new Error("Desktop preparation is unavailable.");
  return structuredClone(saved.admission);
}
function uuid(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}
function requireMain(): void {
  if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw new Error("Desktop preparation is unavailable.");
}
