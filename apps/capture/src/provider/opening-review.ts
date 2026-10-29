import { isUuid } from "../../../review-ui/src/contracts";
import { parseCreatorReview, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { parseProviderEncounter, record, type CoreCaptureScope,
  type ProviderEncounterRecoveryReason } from "./core-client";

/** Display data only, carried through the matched native host during opening. */
export interface ProviderOpeningReview {
  readonly scope: CoreCaptureScope;
  readonly receivedAt: number;
  readonly view: CreatorReviewView | null;
}
export interface ProviderOpeningRecovery {
  readonly scope: CoreCaptureScope;
  readonly receivedAt: number;
  readonly reason: ProviderEncounterRecoveryReason;
}

export function openingReviewFromCore(scope: CoreCaptureScope, nonce: string, value: unknown): ProviderOpeningReview {
  if (!isUuid(nonce) || !record(value) || value.contract_version !== "1"
    || value.workspace_id !== scope.workspaceId || value.binding_ref !== scope.bindingRef
    || value.request_nonce !== nonce || typeof value.checked_at !== "string"
    || !Number.isFinite(Date.parse(value.checked_at))) throw invalid();
  return { scope: Object.freeze({ ...scope }), receivedAt: Date.now(), view: parseProviderEncounter(value) };
}

/** A successful independent mount may carry one closed failed-prefetch disposition. */
export function openingRecoveryFromCore(scope: CoreCaptureScope, nonce: string, value: unknown): ProviderOpeningRecovery {
  if (!isUuid(nonce) || !record(value)
    || Object.keys(value).sort().join(",") !== "binding_ref,contract_version,disposition,request_nonce,workspace_id"
    || value.contract_version !== "1" || value.workspace_id !== scope.workspaceId
    || value.binding_ref !== scope.bindingRef || value.request_nonce !== nonce
    || !["provider_operation_unavailable", "provider_operation_conflict"].includes(String(value.disposition))) throw invalid();
  return { scope: Object.freeze({ ...scope }), receivedAt: Date.now(),
    reason: value.disposition === "provider_operation_unavailable" ? "unavailable" : "conflict" };
}

/** Opening-review negotiation returns exactly one current result, never both. */
export function openingResultFromCore(scope: CoreCaptureScope, nonce: string, value: Record<string, unknown>):
  Readonly<{ openingReview: ProviderOpeningReview }> | Readonly<{ openingRecovery: ProviderOpeningRecovery }> {
  const review = "openingReview" in value, recovery = "openingRecovery" in value;
  if (review === recovery) throw invalid();
  return review ? { openingReview: openingReviewFromCore(scope, nonce, value.openingReview) }
    : { openingRecovery: openingRecoveryFromCore(scope, nonce, value.openingRecovery) };
}

/** Validate after IPC; retain the original timestamp instead of renewing its age. */
export function parseOpeningReview(value: unknown, scope: CoreCaptureScope): ProviderOpeningReview {
  if (!record(value) || Object.keys(value).sort().join(",") !== "receivedAt,scope,view"
    || !record(value.scope) || Object.keys(value.scope).sort().join(",") !== "appointmentRef,bindingRef,workspaceId"
    || value.scope.workspaceId !== scope.workspaceId || value.scope.bindingRef !== scope.bindingRef
    || value.scope.appointmentRef !== scope.appointmentRef || !Number.isSafeInteger(value.receivedAt)
    || Number(value.receivedAt) < 0) throw invalid();
  let view: CreatorReviewView | null = null;
  if (value.view !== null) {
    if (!record(value.view) || !isUuid(value.view.session_id)) throw invalid();
    view = parseCreatorReview(value.view, value.view.session_id);
  }
  return { scope: Object.freeze({ ...scope }), receivedAt: Number(value.receivedAt), view };
}

export function parseOpeningRecovery(value: unknown, scope: CoreCaptureScope): ProviderOpeningRecovery {
  if (!record(value) || Object.keys(value).sort().join(",") !== "reason,receivedAt,scope"
    || !record(value.scope) || Object.keys(value.scope).sort().join(",") !== "appointmentRef,bindingRef,workspaceId"
    || value.scope.workspaceId !== scope.workspaceId || value.scope.bindingRef !== scope.bindingRef
    || value.scope.appointmentRef !== scope.appointmentRef || !Number.isSafeInteger(value.receivedAt)
    || Number(value.receivedAt) < 0 || !["unavailable", "conflict"].includes(String(value.reason))) throw invalid();
  return { scope: Object.freeze({ ...scope }), receivedAt: Number(value.receivedAt),
    reason: value.reason as ProviderEncounterRecoveryReason };
}

/** Workspace calls once after journal recovery. Stale data causes a fresh read. */
export function openingReviewView(value: ProviderOpeningReview | undefined, scope: CoreCaptureScope): CreatorReviewView | null | undefined {
  if (value === undefined) return undefined;
  const checked = parseOpeningReview(value, scope), age = Date.now() - checked.receivedAt;
  return age >= 0 && age <= 5000 ? checked.view : undefined;
}
export function openingRecoveryReason(value: ProviderOpeningRecovery | undefined,
  scope: CoreCaptureScope): ProviderEncounterRecoveryReason | undefined {
  if (value === undefined) return undefined;
  const checked = parseOpeningRecovery(value, scope), age = Date.now() - checked.receivedAt;
  return age >= 0 && age <= 5000 ? checked.reason : undefined;
}
function invalid(): Error { return new Error("provider_opening_review_invalid"); }
