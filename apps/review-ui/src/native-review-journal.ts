import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import { isUuid } from "./contracts";
import {
  parsePendingReviewDecision, type CreatorReviewJournal, type PendingReviewDecision,
} from "./creator-review-journal";

/** Reserved keys in the existing encrypted native store; never audio queue records. */
export const REVIEW_JOURNAL_PREFIX = "creator-review-v1:";

/**
 * Reuses device-only native encryption. The authenticated host supplies a stable,
 * server-bound environment/creator recovery scope and reauthorizes before load.
 * No token, audio key, source text or browser-storage fallback is retained here.
 */
export class NativeCreatorReviewJournal implements CreatorReviewJournal {
  private readonly storageKey: string;

  constructor(
    private readonly plugin: Pick<SecureQueuePlugin, "get" | "create" | "compareAndSwap">,
    private readonly recoveryScope: string,
    private readonly sessionId: string,
  ) {
    if (!isUuid(recoveryScope) || !isUuid(sessionId)) throw failure();
    this.storageKey = `${REVIEW_JOURNAL_PREFIX}${recoveryScope}:${sessionId}`;
  }

  async load(): Promise<PendingReviewDecision | null> {
    return (await this.read())?.operation ?? null;
  }

  async save(value: PendingReviewDecision): Promise<void> {
    const operation = parsePendingReviewDecision(value);
    const current = await this.read();
    if (current?.operation) {
      if (!same(current.operation, operation)) throw failure();
      return;
    }
    const data = this.encode(operation);
    if (current === null) await this.plugin.create({ key: this.storageKey, data });
    else await this.plugin.compareAndSwap({ key: this.storageKey, data, expectedRevision: current.revision });
  }

  async clear(key: string): Promise<void> {
    const current = await this.read();
    if (current === null || current.operation === null) return;
    if (current.operation.key !== key) throw failure();
    // A revision-checked tombstone cannot delete a concurrent, different decision.
    await this.plugin.compareAndSwap({ key: this.storageKey,
      data: this.encode(null), expectedRevision: current.revision });
  }

  private encode(operation: PendingReviewDecision | null): string {
    return btoa(JSON.stringify({ schema_version: "1.0", recovery_scope: this.recoveryScope,
      session_id: this.sessionId, operation }));
  }

  private async read(): Promise<{ revision: string; operation: PendingReviewDecision | null } | null> {
    let stored;
    try { stored = await this.plugin.get({ key: this.storageKey }); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && error.code === "SECURE_QUEUE_NOT_FOUND") return null;
      throw failure();
    }
    try {
      if (stored.key !== this.storageKey || !/^[1-9][0-9]*$/u.test(stored.revision)
        || stored.data.length > 4096) throw failure();
      const value = JSON.parse(atob(stored.data)) as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "operation,recovery_scope,schema_version,session_id"
        || value.schema_version !== "1.0" || value.recovery_scope !== this.recoveryScope
        || value.session_id !== this.sessionId) throw failure();
      return { revision: stored.revision,
        operation: value.operation === null ? null : parsePendingReviewDecision(value.operation) };
    } catch { throw failure(); }
  }
}

function same(left: PendingReviewDecision, right: PendingReviewDecision): boolean {
  return left.key === right.key && Object.keys(left.request).every((key) =>
    left.request[key as keyof typeof left.request] === right.request[key as keyof typeof right.request]);
}
function failure(): Error { return new Error("Review recovery is unavailable."); }
