import { afterEach, expect, it, vi } from "vitest";
import { longReviewFixture } from "../../../review-ui/src/long-review.fixture";
import { openingRecoveryFromCore, openingRecoveryReason, openingResultFromCore,
  openingReviewFromCore, openingReviewView, parseOpeningRecovery, parseOpeningReview } from "./opening-review";

const scope = { workspaceId: "10000000-0000-4000-8000-000000000001",
  appointmentRef: "appointment_01j00000000000000000000000", bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
const nonce = "20000000-0000-4000-8000-000000000002", session = "30000000-0000-4000-8000-000000000003";
const receipt = (view: unknown = null) => ({ contract_version: "1", workspace_id: scope.workspaceId,
  binding_ref: scope.bindingRef, request_nonce: nonce, checked_at: new Date().toISOString(), operation: "provider_encounter",
  receipt: { schema_version: "1.0", status: view === null ? "not_prepared" : "available", review: view } });
afterEach(() => vi.restoreAllMocks());

it("uses the existing long-review parser and preserves all text through serialized IPC", () => {
  const view = longReviewFixture(session), read = openingReviewFromCore(scope, nonce, receipt(view));
  const copied = parseOpeningReview(JSON.parse(JSON.stringify(read)), scope);
  expect(openingReviewView(copied, scope)).toEqual(view);
  expect(copied.receivedAt).toBe(read.receivedAt);
  expect(Object.keys(read).sort()).toEqual(["receivedAt", "scope", "view"]);
});
it("distinguishes a fresh empty encounter from absent, expired or clock-reversed data", () => {
  const now = 2_000_000; vi.spyOn(Date, "now").mockReturnValue(now);
  const read = openingReviewFromCore(scope, nonce, receipt());
  expect(openingReviewView(read, scope)).toBeNull();
  expect(openingReviewView(undefined, scope)).toBeUndefined();
  vi.mocked(Date.now).mockReturnValue(now + 5001);
  expect(openingReviewView(parseOpeningReview(read, scope), scope)).toBeUndefined();
  vi.mocked(Date.now).mockReturnValue(now - 1);
  expect(openingReviewView(read, scope)).toBeUndefined();
});
it.each([
  { contract_version: "2" }, { workspace_id: nonce }, { binding_ref: scope.bindingRef + "1" },
  { request_nonce: session }, { checked_at: "invalid" }, { operation: "creator_review" },
  { receipt: { schema_version: "1.0", status: "not_prepared", review: null, extra: true } },
  { receipt: { schema_version: "1.0", status: "available", review: null } },
])("rejects a mismatched or malformed opening envelope: %j", change => {
  expect(() => openingReviewFromCore(scope, nonce, { ...receipt(), ...change })).toThrow();
});
it.each(["workspaceId", "appointmentRef", "bindingRef"])("rejects %s changed after opening", field => {
  const read = openingReviewFromCore(scope, nonce, receipt());
  expect(() => openingReviewView(read, { ...scope, [field]: nonce })).toThrow();
});
it.each([NaN, Infinity, -1, "1000"])("rejects an invalid IPC timestamp %s", receivedAt => {
  expect(() => parseOpeningReview({ ...openingReviewFromCore(scope, nonce, receipt()), receivedAt }, scope)).toThrow();
});
it.each([
  ["provider_operation_unavailable", "unavailable"],
  ["provider_operation_conflict", "conflict"],
] as const)("carries only the closed opening recovery %s", (disposition, reason) => {
  const envelope = { contract_version: "1", workspace_id: scope.workspaceId, binding_ref: scope.bindingRef,
    request_nonce: nonce, disposition };
  const recovery = openingRecoveryFromCore(scope, nonce, envelope);
  expect(openingRecoveryReason(parseOpeningRecovery(JSON.parse(JSON.stringify(recovery)), scope), scope)).toBe(reason);
  expect(openingResultFromCore(scope, nonce, { openingRecovery: envelope })).toEqual({ openingRecovery: recovery });
});
it.each([
  { disposition: "provider_request_unconfirmed" },
  { disposition: "provider_operation_unavailable", extra: true },
  { workspace_id: nonce }, { binding_ref: scope.bindingRef + "1" }, { request_nonce: session },
])("rejects malformed opening recovery: %j", change => {
  expect(() => openingRecoveryFromCore(scope, nonce, { contract_version: "1", workspace_id: scope.workspaceId,
    binding_ref: scope.bindingRef, request_nonce: nonce, disposition: "provider_operation_unavailable", ...change })).toThrow();
});
it("rejects missing or ambiguous combined opening results", () => {
  const recovery = { contract_version: "1", workspace_id: scope.workspaceId, binding_ref: scope.bindingRef,
    request_nonce: nonce, disposition: "provider_operation_unavailable" };
  expect(() => openingResultFromCore(scope, nonce, {})).toThrow();
  expect(() => openingResultFromCore(scope, nonce, { openingReview: receipt(), openingRecovery: recovery })).toThrow();
});
