import { speakerNameSuggestion } from "../../../review-ui/src/creator-edit";
import { isUuid } from "../../../review-ui/src/contracts";
import { MAX_PROVIDER_RESPONSE_BYTES } from "../../../review-ui/src/capture-response-limits";
import type { ProviderSessionState } from "./native-plugin";

export const DESKTOP_PROVIDER_CHANNELS = Object.freeze({ request: "scribe:provider:workspace:v1", event: "scribe:provider:workspace-event:v1" });
export type DesktopProviderMethod = "session_read" | "sign_in" | "sign_out" | "connect" | "disconnect" | "cancel"
  | "signin_preparation" | "record_ready_timing" | "list" | "create" | "encounter_setup" | "add_birth_date" | "visit_features" | "preflight" | "open" | "core" | "journal_load" | "journal_save" | "edit_load" | "edit_save" | "edit_clear" | "review_load" | "review_save" | "review_clear" | "recorder" | "open_core" | "play_passage";
export interface DesktopProviderRequest {
  readonly requestId: string;
  readonly method: DesktopProviderMethod;
  readonly connectionId: string | null;
  readonly encounterId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}
export type DesktopProviderEvent = { readonly kind: "session"; readonly state: ProviderSessionState }
  | { readonly kind: "connection_closed" | "encounter_closed"; readonly id: string };
/** This is the entire preload surface. It carries intended provider content,
 * never SDK tokens, network destinations or storage/key handles. Passage playback
 * returns bounded WAV content only after native main reauthorizes the segment. */
export interface DesktopProviderPort {
  request(value: DesktopProviderRequest): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
}
const methods: readonly string[] = ["session_read", "sign_in", "sign_out", "connect", "disconnect", "cancel", "signin_preparation", "list", "create", "encounter_setup", "add_birth_date", "visit_features", "preflight", "open", "core",
  "journal_load", "journal_save", "edit_load", "edit_save", "edit_clear", "review_load", "review_save", "review_clear", "recorder", "open_core", "play_passage", "record_ready_timing"];

export function parseDesktopProviderRequest(value: unknown): DesktopProviderRequest {
  const data = exact(value, ["requestId", "method", "connectionId", "encounterId", "payload"]);
  if (typeof data.method !== "string" || !methods.includes(data.method)
    || data.connectionId !== null && !isUuid(data.connectionId) || data.encounterId !== null && !isUuid(data.encounterId)) throw unavailable();
  object(data.payload); uuid(data.requestId);
  return jsonCopy(value, 2 * 1024 * 1024) as DesktopProviderRequest;
}
export function parseDesktopProviderEvent(value: unknown): DesktopProviderEvent {
  const data = object(value);
  if (data.kind === "session") {
    exact(data, ["kind", "state"]); return { kind: "session", state: sessionState(data.state) };
  }
  exact(data, ["kind", "id"]);
  if (data.kind !== "connection_closed" && data.kind !== "encounter_closed") throw unavailable();
  return { kind: data.kind, id: uuid(data.id) };
}
export function sessionState(value: unknown): ProviderSessionState {
  const state = object(value);
  if (typeof state.phase !== "string" || !["disabled", "loading", "signedOut", "signingIn", "ready", "signOutPending", "unavailable"].includes(state.phase)) throw unavailable();
  const name = state.phase === "ready" ? speakerNameSuggestion(state.providerDisplayName) : undefined;
  return { phase: state.phase as ProviderSessionState["phase"], revision: uuid(state.revision),
    ...(name !== undefined ? { providerDisplayName: name } : {}),
    ...(state.phase === "ready" && state.recordingSignInPreparationVersion === 1 ? { recordingSignInPreparationVersion: 1 as const } : {}) };
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const data = object(value);
  if (Object.keys(data).sort().join(",") !== [...keys].sort().join(",")) throw unavailable(); return data;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable(); return value as Record<string, unknown>;
}
export function uuid(value: unknown): string { if (!isUuid(value)) throw unavailable(); return value; }
export function jsonCopy(value: unknown, limit = MAX_PROVIDER_RESPONSE_BYTES): unknown {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || new TextEncoder().encode(encoded).length > limit) throw unavailable();
  return JSON.parse(encoded) as unknown;
}
export function unavailable(): Error { return new Error("Desktop provider workspace is unavailable."); }
