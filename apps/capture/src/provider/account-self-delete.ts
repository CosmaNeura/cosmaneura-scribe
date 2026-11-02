/**
 * Cosmas self-delete client contract for T-REL-8b / Apple 5.1.1(v).
 *
 * Locked against CosmaNeura/cosmaneura PR #940
 * (branch grok/rel8-self-delete-account, head de09c12 / T-REL-8a):
 *   DELETE <api>/v1/me/account
 *   Authorization: Bearer <Clerk JWT>  (native-owned session token)
 *   JSON body: { "confirm": "DELETE" }  (no other fields)
 *   200 + status "deleted"|"already_deleted" → success, then clear local and sign out
 *   401 → clear local and sign out (session already invalid)
 *   422 or anything else → error, stay signed in
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

export type AccountSelfDeleteResult = AccountSelfDeleteSuccess | AccountSelfDeleteUnauthorized;

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
  | "closed";

export interface AccountSelfDeleteState {
  readonly phase: AccountSelfDeletePhase;
  readonly confirmation: string;
  readonly error: string | null;
}

export interface AccountSelfDeleteHost {
  readonly client: AccountSelfDeleteClient;
  /** True while the same signed-in revision remains ready. */
  sameAccountSession(): boolean;
  /** Close clinical workspace after a remote success or unauthorized response. */
  closeWorkspace(): Promise<void>;
  /**
   * After a successful remote delete or 401: clear Keychain/session, preferences
   * and cached local data, leaving the app signed out.
   */
  clearLocalCredentials(): Promise<void>;
}

const CONFIRM: AccountDeleteConfirm = "DELETE";

/** Map Cosmas HTTP status + JSON body to the client result, or throw to stay signed in. */
export function interpretAccountSelfDeleteResponse(status: number, body: unknown): AccountSelfDeleteResult {
  if (status === 401) return { outcome: "unauthorized" };
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

/** Exact confirm fencing; cancel is a no-op; non-401 failure keeps the session. */
export function accountSelfDelete(
  host: AccountSelfDeleteHost,
  changed: (value: AccountSelfDeleteState) => void,
): {
  read(): AccountSelfDeleteState;
  confirm(value: string): void;
  submit(): Promise<void>;
  cancel(): boolean;
  dispose(): void;
} {
  const abort = new AbortController();
  let state: AccountSelfDeleteState = { phase: "confirming", confirmation: "", error: null };
  let running = false;
  let shouldClearLocal = false;
  const publish = (next: AccountSelfDeleteState): void => {
    state = next;
    if (!abort.signal.aborted) changed(state);
  };
  const active = (): boolean => !abort.signal.aborted && host.sameAccountSession();

  return {
    read: () => state,
    confirm: value => {
      if (running || state.phase !== "confirming" || abort.signal.aborted) return;
      publish({ ...state, confirmation: value, error: null });
    },
    submit: async () => {
      if (running || abort.signal.aborted || state.phase === "complete" || state.confirmation !== CONFIRM) return;
      if (!["confirming", "failed"].includes(state.phase)) return;
      running = true;
      publish({ phase: "submitting", confirmation: state.confirmation, error: null });
      try {
        if (!active()) throw new Error("account_self_delete_session_changed");
        // Call Cosmas first so a 422/other failure leaves the signed-in session intact.
        const result = await host.client.deleteAccount({ confirm: CONFIRM }, abort.signal);
        if (result.outcome !== "deleted" && result.outcome !== "unauthorized") {
          throw new Error("account_self_delete_unconfirmed");
        }
        shouldClearLocal = true;
        if (abort.signal.aborted) throw new Error("account_self_delete_aborted");
        // 200 deleted|already_deleted and 401 both clear local credentials and sign out.
        publish({ phase: "clearing", confirmation: "", error: null });
        await host.closeWorkspace();
        await host.clearLocalCredentials();
        if (!abort.signal.aborted) publish({ phase: "complete", confirmation: "", error: null });
      } catch {
        if (!abort.signal.aborted) {
          publish({
            phase: "failed",
            confirmation: state.confirmation === CONFIRM ? CONFIRM : state.confirmation,
            error: shouldClearLocal
              ? "Your Cosmaneura account was deleted, but this device could not finish signing out. Tap Sign out."
              : "Account deletion failed. Your account is still signed in. Try again or contact support.",
          });
        }
      } finally {
        running = false;
      }
    },
    cancel: () => {
      if (running || shouldClearLocal || state.phase === "complete") return false;
      abort.abort();
      state = { phase: "closed", confirmation: "", error: null };
      return true;
    },
    dispose: () => {
      abort.abort();
      state = { phase: "closed", confirmation: "", error: null };
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
