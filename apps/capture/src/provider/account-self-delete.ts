/**
 * Cosmas self-delete client contract for T-REL-8b / Apple 5.1.1(v).
 *
 * Locked against CosmaNeura/cosmaneura PR #940
 * (branch grok/rel8-self-delete-account / T-REL-8a):
 *   DELETE <api>/v1/me/account
 *   Authorization: Bearer <Clerk JWT>  (native-owned session token)
 *   JSON body: { "confirm": "DELETE" }  (no other fields; no target user id)
 *   Identity comes only from the verified token — deletes only the signed-in caller.
 *
 * Status → client behavior:
 *   200 deleted|already_deleted → clear local, sign out, "account deleted" done
 *   401 → clear local, sign out, "session expired" (not account-deleted copy)
 *   410 → clear local, sign out, "This account no longer has access"
 *   404 → keep session, "Account deletion isn't available yet, contact support"
 *   503 → keep session, retryable ("Try again")
 *   409 / 422 / other → keep session, generic failure
 *
 * Existing live users: nothing changes unless they open Account and confirm Delete.
 */

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

export interface AccountSelfDeleteUnauthorized {
  readonly outcome: "unauthorized";
}

export interface AccountSelfDeleteGone {
  readonly outcome: "gone";
}

export interface AccountSelfDeleteUnavailable {
  readonly outcome: "unavailable";
}

export interface AccountSelfDeleteRetryable {
  readonly outcome: "retryable";
}

export type AccountSelfDeleteResult =
  | AccountSelfDeleteSuccess
  | AccountSelfDeleteUnauthorized
  | AccountSelfDeleteGone
  | AccountSelfDeleteUnavailable
  | AccountSelfDeleteRetryable;

/** Authenticated Cosmas account deletion. Tokens stay in the native host. */
export interface AccountSelfDeleteClient {
  deleteAccount(request: AccountSelfDeleteRequest, signal?: AbortSignal): Promise<AccountSelfDeleteResult>;
}

export type AccountSelfDeletePhase =
  | "confirming"
  | "submitting"
  | "failed"
  | "clearing"
  | "complete"
  | "local_clear_failed"
  | "closed";

export type AccountSelfDeleteCompletion =
  | "deleted"
  | "session_expired"
  | "gone"
  | "local_clear_failed";

export interface AccountSelfDeleteState {
  readonly phase: AccountSelfDeletePhase;
  readonly confirmation: string;
  readonly error: string | null;
  readonly retryable: boolean;
  readonly completion: AccountSelfDeleteCompletion | null;
}

export interface AccountSelfDeleteHost {
  readonly client: AccountSelfDeleteClient;
  /** True while the same signed-in revision remains ready. */
  sameAccountSession(): boolean;
  /** Close clinical workspace after a remote success that requires local clear. */
  closeWorkspace(): Promise<void>;
  /**
   * After a remote outcome that ends the session: clear Keychain/session and
   * preferences. Must attempt sign-out even when workspace close failed.
   */
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
} as const;

export const ACCOUNT_SELF_DELETE_MESSAGES = MESSAGES;

/** Map Cosmas HTTP status + JSON body to the client result. */
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
    outcome: "deleted",
    status: row.status,
    practiceLeftOwnerless: row.practice_left_ownerless,
    clerkIdentityRemoved: row.clerk_identity_removed,
  };
}

/** Map a native/IPC bridge payload into the typed client result. */
export function interpretAccountSelfDeleteBridge(value: unknown): AccountSelfDeleteResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("account_self_delete_bridge");
  const row = value as Record<string, unknown>;
  if (row.unauthorized === true && Object.keys(row).length === 1) return { outcome: "unauthorized" };
  if (row.gone === true && Object.keys(row).length === 1) return { outcome: "gone" };
  if (row.unavailable === true && Object.keys(row).length === 1) return { outcome: "unavailable" };
  if (row.retryable === true && Object.keys(row).length === 1) return { outcome: "retryable" };
  if ((row.status === "deleted" || row.status === "already_deleted")
    && typeof row.practiceLeftOwnerless === "boolean"
    && typeof row.clerkIdentityRemoved === "boolean"
    && Object.keys(row).sort().join(",") === "clerkIdentityRemoved,practiceLeftOwnerless,status") {
    return {
      outcome: "deleted",
      status: row.status,
      practiceLeftOwnerless: row.practiceLeftOwnerless,
      clerkIdentityRemoved: row.clerkIdentityRemoved,
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
  let state: AccountSelfDeleteState = {
    phase: "confirming", confirmation: "", error: null, retryable: false, completion: null,
  };
  let running = false;
  let serverEndedSession = false;
  const publish = (next: AccountSelfDeleteState): void => {
    state = next;
    if (!abort.signal.aborted) changed(state);
  };
  const active = (): boolean => !abort.signal.aborted && host.sameAccountSession();

  return {
    read: () => state,
    confirm: value => {
      if (running || abort.signal.aborted) return;
      // Keep-session failures (including retryable 503) may edit confirmation.
      if (state.phase !== "confirming" && state.phase !== "failed") return;
      if (state.completion !== null) return;
      publish({
        phase: "confirming",
        confirmation: value,
        error: null,
        retryable: false,
        completion: null,
      });
    },
    submit: async () => {
      if (running || abort.signal.aborted || state.phase === "complete" || state.phase === "local_clear_failed") return;
      if (state.confirmation !== CONFIRM) return;
      if (!["confirming", "failed"].includes(state.phase)) return;
      running = true;
      publish({ phase: "submitting", confirmation: state.confirmation, error: null, retryable: false, completion: null });
      try {
        if (!active()) throw new Error("account_self_delete_session_changed");
        const result = await host.client.deleteAccount({ confirm: CONFIRM }, abort.signal);
        if (result.outcome === "unavailable") {
          publish({
            phase: "failed", confirmation: CONFIRM, error: MESSAGES.unavailable, retryable: false, completion: null,
          });
          return;
        }
        if (result.outcome === "retryable") {
          publish({
            phase: "failed", confirmation: CONFIRM, error: MESSAGES.retryable, retryable: true, completion: null,
          });
          return;
        }
        if (!endsSession(result)) throw new Error("account_self_delete_unconfirmed");
        const completion = completionFor(result);
        if (completion === null) throw new Error("account_self_delete_unconfirmed");
        serverEndedSession = true;
        if (abort.signal.aborted) throw new Error("account_self_delete_aborted");
        publish({ phase: "clearing", confirmation: "", error: null, retryable: false, completion });
        // Always attempt sign-out even when workspace close fails.
        await host.closeWorkspace().catch(() => undefined);
        await host.clearLocalCredentials();
        if (!abort.signal.aborted) {
          publish({ phase: "complete", confirmation: "", error: null, retryable: false, completion });
        }
      } catch {
        if (!abort.signal.aborted) {
          if (serverEndedSession) {
            publish({
              phase: "local_clear_failed",
              confirmation: "",
              error: MESSAGES.localClearFailed,
              retryable: false,
              completion: "local_clear_failed",
            });
          } else {
            publish({
              phase: "failed",
              confirmation: state.confirmation === CONFIRM ? CONFIRM : state.confirmation,
              error: MESSAGES.keepSession,
              retryable: false,
              completion: null,
            });
          }
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
      state = { phase: "closed", confirmation: "", error: null, retryable: false, completion: null };
      return true;
    },
    /** Close/Done after a finished remote outcome (including local-clear failure). */
    acknowledge: () => {
      if (state.phase !== "complete" && state.phase !== "local_clear_failed") return false;
      abort.abort();
      state = { phase: "closed", confirmation: "", error: null, retryable: false, completion: state.completion };
      return true;
    },
    dispose: () => {
      abort.abort();
      state = { phase: "closed", confirmation: "", error: null, retryable: false, completion: state.completion };
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
