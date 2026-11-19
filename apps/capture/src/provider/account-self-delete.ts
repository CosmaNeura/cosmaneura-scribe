/** Cosmas self-delete (T-REL-8b / Apple 5.1.1(v) / Core #940). */

export type AccountDeleteConfirm = "DELETE";

export interface AccountSelfDeleteRequest {
  readonly confirm: AccountDeleteConfirm;
}

export type AccountSelfDeleteStatus = "deleted" | "already_deleted";

export interface AccountSelfDeleteSuccess {
  readonly outcome: "deleted";
  readonly status: AccountSelfDeleteStatus;
  readonly practiceLeftOwnerless: boolean;
  readonly clerkIdentityRemoved: boolean;
}

export interface AccountSelfDeleteUnauthorized { readonly outcome: "unauthorized"; }
export interface AccountSelfDeleteGone { readonly outcome: "gone"; }
export interface AccountSelfDeleteUnavailable { readonly outcome: "unavailable"; }
export interface AccountSelfDeleteRetryable { readonly outcome: "retryable"; }
export interface AccountSelfDeleteRecordingActive { readonly outcome: "recording_active"; }

export type AccountSelfDeleteResult =
  | AccountSelfDeleteSuccess
  | AccountSelfDeleteUnauthorized
  | AccountSelfDeleteGone
  | AccountSelfDeleteUnavailable
  | AccountSelfDeleteRetryable
  | AccountSelfDeleteRecordingActive;

export interface AccountSelfDeleteClient {
  deleteAccount(request: AccountSelfDeleteRequest, signal?: AbortSignal): Promise<AccountSelfDeleteResult>;
}

export type AccountSelfDeletePhase =
  | "confirming" | "submitting" | "failed" | "clearing" | "complete" | "local_clear_failed" | "closed";

export type AccountSelfDeleteCompletion =
  | "deleted" | "session_expired" | "gone" | "local_clear_failed";

export interface AccountSelfDeleteState {
  readonly phase: AccountSelfDeletePhase;
  readonly confirmation: string;
  readonly error: string | null;
  readonly retryable: boolean;
  readonly completion: AccountSelfDeleteCompletion | null;
  /** Set on deleted success; dialog shows practiceLeftOwnerlessNotice when true. */
  readonly practiceLeftOwnerless: boolean | null;
}

export interface AccountSelfDeleteHost {
  readonly client: AccountSelfDeleteClient;
  sameAccountSession(): boolean;
  closeWorkspace(): Promise<void>;
  /** Wipe journal/drafts/review/queued audio/recordings so "Clearing this device" is true. */
  purgeLocalClinicalData(): Promise<void>;
  clearLocalCredentials(): Promise<void>;
}

const CONFIRM: AccountDeleteConfirm = "DELETE";

const MESSAGES = {
  unavailable: "Account deletion isn't available yet, contact support",
  retryable: "Account deletion is temporarily unavailable. Try again.",
  keepSession: "Account deletion failed. Your account is still signed in. Try again or contact support.",
  localClearFailed:
    "Your Cosmaneura account was deleted, but this device could not finish signing out. Tap Done, then Retry sign out.",
  sessionExpired: "Your session has expired. You are signed out.",
  gone: "This account no longer has access. You are signed out.",
  deleted: "Your account has been deleted. You are signed out.",
  recordingActive: "Stop the recording before deleting your account.",
  /** Confirm-dialog body (John, in-app chat, Nov 19 2026 11:53am ET, relayed via CoS). */
  confirmBody:
    "This removes your Cosmaneura sign-in, including Cosmas web access, and deletes your personal Scribe data for this account on this device. Your practice record and clinical records kept with the practice are not deleted by this action.",
  /** Shown only when practiceLeftOwnerless is true (same source as confirmBody). */
  practiceLeftOwnerlessNotice:
    "If you were the last owner of this practice, Cosmaneura may keep the practice record so billing and retention obligations can finish. Your sign-in is removed; the practice is not deleted by this action.",
} as const;

export const ACCOUNT_SELF_DELETE_MESSAGES = MESSAGES;

export function interpretAccountSelfDeleteResponse(status: number, body: unknown): AccountSelfDeleteResult {
  if (status === 401) return { outcome: "unauthorized" };
  if (status === 410) return { outcome: "gone" };
  if (status === 404) return { outcome: "unavailable" };
  if (status === 503) return { outcome: "retryable" };
  if (status !== 200) throw new Error(`account_self_delete_http_${status}`);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("account_self_delete_body");
  const row = body as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "clerk_identity_removed,practice_left_ownerless,status") {
    throw new Error("account_self_delete_body");
  }
  if (row.status !== "deleted" && row.status !== "already_deleted") throw new Error("account_self_delete_body");
  if (typeof row.practice_left_ownerless !== "boolean" || typeof row.clerk_identity_removed !== "boolean") {
    throw new Error("account_self_delete_body");
  }
  return {
    outcome: "deleted", status: row.status,
    practiceLeftOwnerless: row.practice_left_ownerless, clerkIdentityRemoved: row.clerk_identity_removed,
  };
}

export function interpretAccountSelfDeleteBridge(value: unknown): AccountSelfDeleteResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("account_self_delete_bridge");
  const row = value as Record<string, unknown>;
  if (row.unauthorized === true && Object.keys(row).length === 1) return { outcome: "unauthorized" };
  if (row.gone === true && Object.keys(row).length === 1) return { outcome: "gone" };
  if (row.unavailable === true && Object.keys(row).length === 1) return { outcome: "unavailable" };
  if (row.retryable === true && Object.keys(row).length === 1) return { outcome: "retryable" };
  if (row.recordingActive === true && Object.keys(row).length === 1) return { outcome: "recording_active" };
  if ((row.status === "deleted" || row.status === "already_deleted")
    && typeof row.practiceLeftOwnerless === "boolean"
    && typeof row.clerkIdentityRemoved === "boolean"
    && Object.keys(row).sort().join(",") === "clerkIdentityRemoved,practiceLeftOwnerless,status") {
    return {
      outcome: "deleted", status: row.status,
      practiceLeftOwnerless: row.practiceLeftOwnerless, clerkIdentityRemoved: row.clerkIdentityRemoved,
    };
  }
  throw new Error("account_self_delete_bridge");
}

function completionFor(result: AccountSelfDeleteResult): AccountSelfDeleteCompletion | null {
  if (result.outcome === "deleted") return "deleted";
  if (result.outcome === "unauthorized") return "session_expired";
  if (result.outcome === "gone") return "gone";
  return null;
}

function endsSession(result: AccountSelfDeleteResult): boolean {
  return result.outcome === "deleted" || result.outcome === "unauthorized" || result.outcome === "gone";
}

const idle = (): AccountSelfDeleteState => ({
  phase: "confirming", confirmation: "", error: null, retryable: false, completion: null, practiceLeftOwnerless: null,
});

/** Exact confirm fencing; cancel is a no-op; keep-session failures leave credentials. */
export function accountSelfDelete(
  host: AccountSelfDeleteHost,
  changed: (value: AccountSelfDeleteState) => void,
): {
  read(): AccountSelfDeleteState;
  confirm(value: string): void;
  submit(): Promise<void>;
  cancel(): boolean;
  acknowledge(): boolean;
  dispose(): void;
} {
  const abort = new AbortController();
  let state: AccountSelfDeleteState = idle();
  let running = false;
  let serverEndedSession = false;
  const publish = (next: AccountSelfDeleteState): void => {
    state = next;
    if (!abort.signal.aborted) changed(state);
  };
  const active = (): boolean => !abort.signal.aborted && host.sameAccountSession();
  const base = (phase: AccountSelfDeletePhase, rest: Partial<AccountSelfDeleteState> = {}): AccountSelfDeleteState => ({
    phase, confirmation: "", error: null, retryable: false, completion: null, practiceLeftOwnerless: null, ...rest,
  });

  return {
    read: () => state,
    confirm: value => {
      if (running || abort.signal.aborted) return;
      if (state.phase !== "confirming" && state.phase !== "failed") return;
      if (state.completion !== null) return;
      publish(base("confirming", { confirmation: value }));
    },
    submit: async () => {
      if (running || abort.signal.aborted || state.phase === "complete" || state.phase === "local_clear_failed") return;
      if (state.confirmation !== CONFIRM) return;
      if (!["confirming", "failed"].includes(state.phase)) return;
      running = true;
      publish(base("submitting", { confirmation: CONFIRM }));
      try {
        if (!active()) throw new Error("account_self_delete_session_changed");
        const result = await host.client.deleteAccount({ confirm: CONFIRM }, abort.signal);
        if (result.outcome === "unavailable") {
          publish(base("failed", { confirmation: CONFIRM, error: MESSAGES.unavailable }));
          return;
        }
        if (result.outcome === "retryable") {
          publish(base("failed", { confirmation: CONFIRM, error: MESSAGES.retryable, retryable: true }));
          return;
        }
        if (result.outcome === "recording_active") {
          publish(base("failed", { confirmation: CONFIRM, error: MESSAGES.recordingActive }));
          return;
        }
        if (!endsSession(result)) throw new Error("account_self_delete_unconfirmed");
        const completion = completionFor(result);
        if (completion === null) throw new Error("account_self_delete_unconfirmed");
        serverEndedSession = true;
        const ownerless = result.outcome === "deleted" ? result.practiceLeftOwnerless : false;
        // Clinical purge only on deleted — 401/410 clear credentials but keep local clinical data.
        const shouldPurge = result.outcome === "deleted";
        publish(base("clearing", { completion, practiceLeftOwnerless: ownerless }));
        await host.closeWorkspace().catch(() => undefined);
        let purgeFailed = false;
        if (shouldPurge) {
          try { await host.purgeLocalClinicalData(); } catch { purgeFailed = true; }
        }
        await host.clearLocalCredentials();
        if (purgeFailed) throw new Error("clinical_purge_failed");
        publish(base("complete", { completion, practiceLeftOwnerless: ownerless }));
      } catch {
        if (serverEndedSession) {
          publish(base("local_clear_failed", {
            error: MESSAGES.localClearFailed, completion: "local_clear_failed",
            practiceLeftOwnerless: state.practiceLeftOwnerless,
          }));
        } else if (!abort.signal.aborted) {
          publish(base("failed", {
            confirmation: state.confirmation === CONFIRM ? CONFIRM : state.confirmation,
            error: MESSAGES.keepSession,
          }));
        }
      } finally {
        running = false;
      }
    },
    cancel: () => {
      if (running || serverEndedSession || state.phase === "complete" || state.phase === "local_clear_failed") {
        return false;
      }
      abort.abort();
      state = base("closed");
      return true;
    },
    acknowledge: () => {
      if (state.phase !== "complete" && state.phase !== "local_clear_failed") return false;
      abort.abort();
      state = base("closed", { completion: state.completion, practiceLeftOwnerless: state.practiceLeftOwnerless });
      return true;
    },
    dispose: () => {
      abort.abort();
      state = base("closed", { completion: state.completion, practiceLeftOwnerless: state.practiceLeftOwnerless });
    },
  };
}

/** Remove nonclinical preference cache keys after a successful account delete. */
export function clearCachedProviderPreferences(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("scribe-preferences-v1:")) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* Preferences are best-effort; Keychain/session clear is authoritative. */
  }
}
