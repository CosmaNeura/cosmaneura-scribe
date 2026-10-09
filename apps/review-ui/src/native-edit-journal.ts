import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import { isUuid } from "./contracts";
import {
  parsePendingCreatorEdit, type CreatorEditJournal, type PendingCreatorEdit,
} from "./creator-edit";

/** Reserved keys in the existing encrypted native store; never audio queue records. */
export const EDIT_JOURNAL_PREFIX = "creator-transcript-edit-v1:";

/**
 * Reuses device-only native encryption. The authenticated host supplies a stable,
 * server-bound environment/creator recovery scope and reauthorizes before load.
 * Protected correction text is retained only inside the native encrypted store.
 * No token, audio key or browser-storage fallback is retained here.
 */
export class NativeCreatorEditJournal implements CreatorEditJournal {
  private readonly storageKey: string;

  constructor(
    private readonly plugin: Pick<SecureQueuePlugin, "get" | "create" | "compareAndSwap">,
    private readonly recoveryScope: string,
    private readonly sessionId: string,
  ) {
    if (!isUuid(recoveryScope) || !isUuid(sessionId)) throw failure();
    this.storageKey = `${EDIT_JOURNAL_PREFIX}${recoveryScope}:${sessionId}`;
  }

  async load(): Promise<PendingCreatorEdit | null> {
    return (await this.read())?.operation ?? null;
  }

  async save(value: PendingCreatorEdit): Promise<void> {
    const operation = parsePendingCreatorEdit(value);
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

  private encode(operation: PendingCreatorEdit | null): string {
    const raw = new TextEncoder().encode(JSON.stringify({ schema_version: "1.0", recovery_scope: this.recoveryScope,
      session_id: this.sessionId, operation }));
    if (raw.length > 1_100_000) throw failure();
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  private async read(): Promise<{ revision: string; operation: PendingCreatorEdit | null } | null> {
    let stored;
    try { stored = await this.plugin.get({ key: this.storageKey }); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && error.code === "SECURE_QUEUE_NOT_FOUND") return null;
      throw failure();
    }
    try {
      if (stored.key !== this.storageKey || !/^[1-9][0-9]*$/u.test(stored.revision)
        || stored.data.length > 1_500_000) throw failure();
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(stored.data), c => c.charCodeAt(0)))) as Record<string, unknown>;
      if (Object.keys(value).sort().join(",") !== "operation,recovery_scope,schema_version,session_id"
        || value.schema_version !== "1.0" || value.recovery_scope !== this.recoveryScope
        || value.session_id !== this.sessionId) throw failure();
      return { revision: stored.revision,
        operation: value.operation === null ? null : parsePendingCreatorEdit(value.operation) };
    } catch { throw failure(); }
  }
}

function same(left: PendingCreatorEdit, right: PendingCreatorEdit): boolean {
  return left.key === right.key && canonical(left.request) === canonical(right.request);
}
function failure(): Error { return new Error("Transcript edit recovery is unavailable."); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null) return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry)).join(",") + "}";
  return JSON.stringify(value);
}
