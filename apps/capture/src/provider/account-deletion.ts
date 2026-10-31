/** Dormant UI contract. No host/HTTP/native adapter is registered by this module. */
export interface AccountDeletionPreview {
  readonly revision: string;
  readonly scope: "cosmaneura-account";
  readonly retainsPracticeRecords: boolean;
  readonly isSolePracticeOwner: boolean;
}
export type AccountDeletionReceipt =
  | { readonly requestReference: string; readonly status: "pending"; readonly completionDeadline: string }
  | { readonly requestReference: string; readonly status: "complete" };
export interface AccountDeletionRequest {
  readonly previewRevision: string;
  readonly confirmation: "DELETE";
  readonly idempotencyKey: string;
}
export interface AccountDeletionHost {
  /** All operations act on the host's verified caller; no user ID is accepted. */
  preview(signal: AbortSignal): Promise<AccountDeletionPreview>;
  sameAccountSession(): boolean;
  closeWorkspace(): Promise<void>;
  request(request: AccountDeletionRequest, signal: AbortSignal): Promise<AccountDeletionReceipt>;
  /** Native owns durable original-account recovery, including after Clerk revocation. */
  status(requestReference: string, signal: AbortSignal): Promise<AccountDeletionReceipt>;
  /** Idempotent normal native credential cleanup and original-account local cleanup. */
  finishLocalDeletion(): Promise<void>;
}
export interface AccountDeletionState {
  readonly phase: "loading" | "confirming" | "submitting" | "pending" | "failed" | "cleaning" | "complete" | "closed";
  readonly preview: AccountDeletionPreview | null;
  readonly receipt: AccountDeletionReceipt | null;
  readonly confirmation: string;
  readonly requestSubmitted: boolean;
}

const digest = /^[a-f0-9]{64}$/;
const reference = /^[A-Za-z0-9_-]{16,160}$/;
function validPreview(value: AccountDeletionPreview): boolean {
  return !!value && Object.keys(value).sort().join(",") === "isSolePracticeOwner,retainsPracticeRecords,revision,scope"
    && digest.test(value.revision) && value.scope === "cosmaneura-account"
    && typeof value.retainsPracticeRecords === "boolean" && typeof value.isSolePracticeOwner === "boolean";
}
function validReceipt(value: AccountDeletionReceipt): boolean {
  if (!value || !reference.test(value.requestReference)) return false;
  if (value.status === "complete") return Object.keys(value).sort().join(",") === "requestReference,status";
  return value.status === "pending"
    && Object.keys(value).sort().join(",") === "completionDeadline,requestReference,status"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.completionDeadline)
    && Number.isFinite(Date.parse(value.completionDeadline));
}

/** Exact confirmation and stop-before-request fencing; every failure stays visible. */
export function accountDeletion(host: AccountDeletionHost, changed: (value: AccountDeletionState) => void): {
  read(): AccountDeletionState; load(): Promise<void>; confirm(value: string): void;
  submit(): Promise<void>; retry(): Promise<void>; cancel(): boolean; dispose(): void;
} {
  const abort = new AbortController();
  const key = crypto.randomUUID();
  let state: AccountDeletionState = { phase: "loading", preview: null, receipt: null, confirmation: "", requestSubmitted: false };
  let running = false, requestStarted = false;
  const publish = (next: AccountDeletionState): void => { state = next; if (!abort.signal.aborted) changed(state); };
  const active = (): boolean => !abort.signal.aborted && host.sameAccountSession();
  const failed = (): void => { if (!abort.signal.aborted) publish({ ...state, phase: "failed" }); };
  const finish = async (): Promise<void> => {
    if (!active()) throw new Error("account_deletion_unconfirmed");
    publish({ ...state, phase: "cleaning" });
    await host.finishLocalDeletion();
    if (!abort.signal.aborted) publish({ ...state, phase: "complete", confirmation: "" });
  };
  const accept = async (value: AccountDeletionReceipt): Promise<void> => {
    if (!validReceipt(value) || state.receipt && state.receipt.requestReference !== value.requestReference) throw new Error("account_deletion_unconfirmed");
    if (!active()) throw new Error("account_deletion_unconfirmed");
    publish({ ...state, receipt: { ...value }, phase: value.status === "complete" ? "cleaning" : "pending" });
    if (value.status === "complete") await finish();
  };
  const load = async (): Promise<void> => {
    if (running || requestStarted || abort.signal.aborted) return;
    running = true;
    publish({ ...state, phase: "loading", preview: null, confirmation: "" });
    try {
      if (!active()) throw new Error("account_deletion_unconfirmed");
      const value = await host.preview(abort.signal);
      if (!active() || !validPreview(value)) throw new Error("account_deletion_unconfirmed");
      publish({ ...state, preview: { ...value }, phase: "confirming" });
    } catch { failed(); } finally { running = false; }
  };
  const submit = async (): Promise<void> => {
    if (running || abort.signal.aborted || state.confirmation !== "DELETE" || !state.preview
      || !["confirming", "failed"].includes(state.phase) || state.receipt) return;
    running = true;
    publish({ ...state, phase: "submitting" });
    try {
      if (!active()) throw new Error("account_deletion_unconfirmed");
      await host.closeWorkspace();
      if (!active()) throw new Error("account_deletion_unconfirmed");
      requestStarted = true;
      publish({ ...state, requestSubmitted: true });
      const value = await host.request({ previewRevision: state.preview.revision, confirmation: "DELETE", idempotencyKey: key }, abort.signal);
      await accept(value);
    } catch { failed(); } finally { running = false; }
  };
  const retry = async (): Promise<void> => {
    if (running || abort.signal.aborted || state.phase === "complete") return;
    if (!state.preview) return load();
    if (!state.receipt) return submit();
    running = true;
    try {
      if (!active()) throw new Error("account_deletion_unconfirmed");
      if (state.receipt.status === "complete") await finish();
      else { publish({ ...state, phase: "submitting" }); await accept(await host.status(state.receipt.requestReference, abort.signal)); }
    } catch { failed(); } finally { running = false; }
  };
  return {
    read: () => state, load, submit, retry,
    confirm: value => { if (!running && !requestStarted && state.phase === "confirming") publish({ ...state, confirmation: value }); },
    cancel: () => {
      if (requestStarted || running && state.phase !== "loading" || state.phase === "complete") return false;
      abort.abort(); state = { ...state, phase: "closed", confirmation: "" }; return true;
    },
    dispose: () => { abort.abort(); state = { ...state, phase: "closed", confirmation: "" }; },
  };
}
