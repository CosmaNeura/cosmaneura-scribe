import { describe, expect, it, vi } from "vitest";
import { accountDeletion, type AccountDeletionHost, type AccountDeletionReceipt } from "./account-deletion";
const preview = { revision: "a".repeat(64), scope: "cosmaneura-account" as const, retainsPracticeRecords: true, isSolePracticeOwner: true };
const complete: AccountDeletionReceipt = { requestReference: "synthetic_deletion_1", status: "complete" };
const pending: AccountDeletionReceipt = { requestReference: "synthetic_deletion_1", status: "pending", completionDeadline: "2026-11-01T18:00:00Z" };
function fixture() {
  const calls: string[] = [];
  const host = {
    preview: vi.fn<AccountDeletionHost["preview"]>(async () => preview),
    sameAccountSession: vi.fn<AccountDeletionHost["sameAccountSession"]>(() => true),
    closeWorkspace: vi.fn<AccountDeletionHost["closeWorkspace"]>(async () => { calls.push("stop"); }),
    request: vi.fn<AccountDeletionHost["request"]>(async () => { calls.push("request"); return complete; }),
    status: vi.fn<AccountDeletionHost["status"]>(async () => complete),
    finishLocalDeletion: vi.fn<AccountDeletionHost["finishLocalDeletion"]>(async () => { calls.push("cleanup"); }),
  } satisfies AccountDeletionHost;
  const flow = accountDeletion(host, () => undefined);
  return { host, flow, calls };
}
describe("dormant self-only account deletion UI workflow", () => {
  it.each(["", "delete", " Delete", "DELETE ", "yes"])("does not submit for %j", async value => {
    const { host, flow } = fixture(); await flow.load(); flow.confirm(value); await flow.submit();
    expect(host.request).not.toHaveBeenCalled(); expect(host.closeWorkspace).not.toHaveBeenCalled();
  });
  it("Cancel has no deletion, native cleanup or workspace side effect", async () => {
    const { host, flow } = fixture(); await flow.load(); flow.confirm("DELETE"); expect(flow.cancel()).toBe(true); await flow.submit();
    expect(flow.read().phase).toBe("closed"); expect(host.request).not.toHaveBeenCalled(); expect(host.closeWorkspace).not.toHaveBeenCalled(); expect(host.finishLocalDeletion).not.toHaveBeenCalled();
  });
  it("stops first and sends only confirmation, preview revision and an idempotency key", async () => {
    const { host, flow, calls } = fixture(); await flow.load(); flow.confirm("DELETE"); await flow.submit();
    expect(calls).toEqual(["stop", "request", "cleanup"]);
    expect(Object.keys(vi.mocked(host.request).mock.calls[0]![0]).sort()).toEqual(["confirmation", "idempotencyKey", "previewRevision"]);
    expect(flow.read().phase).toBe("complete");
  });
  it("does not request deletion when recorder cessation is unconfirmed", async () => {
    const { host, flow } = fixture(); vi.mocked(host.closeWorkspace).mockRejectedValue(new Error("synthetic_stop_failure"));
    await flow.load(); flow.confirm("DELETE"); await flow.submit();
    expect(flow.read().phase).toBe("failed"); expect(host.request).not.toHaveBeenCalled(); expect(host.finishLocalDeletion).not.toHaveBeenCalled();
  });
  it("does not mutate after the account changes while the workspace stops", async () => {
    const { host, flow } = fixture(); vi.mocked(host.closeWorkspace).mockImplementation(async () => { vi.mocked(host.sameAccountSession).mockReturnValue(false); });
    await flow.load(); flow.confirm("DELETE"); await flow.submit(); expect(host.request).not.toHaveBeenCalled(); expect(flow.read().phase).toBe("failed");
  });
  it("retains the same request key after a lost deletion response", async () => {
    const { host, flow } = fixture(); vi.mocked(host.request).mockRejectedValueOnce(new Error("synthetic_response_lost"));
    await flow.load(); flow.confirm("DELETE"); await flow.submit(); expect(flow.cancel()).toBe(false); await flow.retry();
    expect(vi.mocked(host.request).mock.calls[0]![0]).toEqual(vi.mocked(host.request).mock.calls[1]![0]); expect(flow.read().phase).toBe("complete");
  });
  it("shows pending rather than success, then polls the same request without another delete", async () => {
    const { host, flow } = fixture(); vi.mocked(host.request).mockResolvedValue(pending);
    await flow.load(); flow.confirm("DELETE"); await flow.submit(); expect(flow.read().phase).toBe("pending"); expect(host.finishLocalDeletion).not.toHaveBeenCalled();
    await flow.retry(); expect(host.status).toHaveBeenCalledWith(pending.requestReference, expect.any(AbortSignal)); expect(host.request).toHaveBeenCalledOnce(); expect(flow.read().phase).toBe("complete");
  });
  it("retries only local cleanup after server completion", async () => {
    const { host, flow } = fixture(); vi.mocked(host.finishLocalDeletion).mockRejectedValueOnce(new Error("synthetic_local_cleanup_failure"));
    await flow.load(); flow.confirm("DELETE"); await flow.submit(); expect(flow.read().phase).toBe("failed"); await flow.retry();
    expect(host.request).toHaveBeenCalledOnce(); expect(host.status).not.toHaveBeenCalled(); expect(host.finishLocalDeletion).toHaveBeenCalledTimes(2); expect(flow.read().phase).toBe("complete");
  });
  it("keeps confirmed completion terminal after a late retry", async () => {
    const { host, flow } = fixture(); await flow.load(); flow.confirm("DELETE"); await flow.submit();
    vi.mocked(host.finishLocalDeletion).mockRejectedValue(new Error("synthetic_cleanup_must_not_repeat"));
    await flow.retry();
    expect(flow.read().phase).toBe("complete"); expect(host.request).toHaveBeenCalledOnce();
    expect(host.status).not.toHaveBeenCalled(); expect(host.finishLocalDeletion).toHaveBeenCalledOnce();
  });
  it("cannot clear a different account after a delayed server completion", async () => {
    const { host, flow } = fixture(); vi.mocked(host.request).mockImplementation(async () => { vi.mocked(host.sameAccountSession).mockReturnValue(false); return complete; });
    await flow.load(); flow.confirm("DELETE"); await flow.submit(); expect(host.finishLocalDeletion).not.toHaveBeenCalled(); expect(flow.read().phase).toBe("failed");
  });
  it("refuses a mismatched status reference", async () => {
    const { host, flow } = fixture(); vi.mocked(host.request).mockResolvedValue(pending); vi.mocked(host.status).mockResolvedValue({ ...complete, requestReference: "synthetic_other_2" });
    await flow.load(); flow.confirm("DELETE"); await flow.submit(); await flow.retry(); expect(flow.read().phase).toBe("failed"); expect(host.finishLocalDeletion).not.toHaveBeenCalled();
  });
  it("refuses an unqualified preview without asking for confirmation", async () => {
    const { host, flow } = fixture(); vi.mocked(host.preview).mockResolvedValue({ ...preview, revision: "foreign" });
    await flow.load(); flow.confirm("DELETE"); await flow.submit(); expect(flow.read().phase).toBe("failed"); expect(host.request).not.toHaveBeenCalled();
  });
  it("refuses concurrent submissions", async () => {
    const { host, flow } = fixture(); let finish!: (value: AccountDeletionReceipt) => void;
    vi.mocked(host.request).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await flow.load(); flow.confirm("DELETE"); const first = flow.submit(); await new Promise(resolve => setTimeout(resolve, 0)); await flow.submit(); finish(complete); await first;
    expect(host.request).toHaveBeenCalledOnce();
  });
});
