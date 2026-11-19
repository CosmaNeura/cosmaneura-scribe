import {
  ACCOUNT_SELF_DELETE_MESSAGES,
  accountSelfDelete,
  type AccountSelfDeleteHost,
  type AccountSelfDeleteState,
} from "./account-self-delete";
import "./account-self-delete-dialog.css";

/** Full-screen confirm for Account > Delete account (Apple 5.1.1(v)). */
export function mountAccountSelfDeleteDialog(parent: HTMLElement, host: AccountSelfDeleteHost): () => void {
  const priorFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "scribe-account-self-delete";
  dialog.setAttribute("aria-labelledby", "scribe-account-self-delete-title");
  dialog.innerHTML = `<section>
    <h1 id="scribe-account-self-delete-title">Delete your account?</h1>
    <p data-confirm-body></p>
    <p data-pending-upload-notice></p>
    <p data-ownerless-notice hidden></p>
    <label data-confirmation-label>Type DELETE to confirm
      <input data-confirmation autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Type DELETE to confirm">
    </label>
    <p data-status role="status" aria-live="polite"></p>
    <div class="scribe-self-delete-actions">
      <button data-cancel type="button">Cancel</button>
      <button data-submit type="button" disabled>Delete account</button>
      <button data-done type="button" hidden>Done</button>
      <button data-retry type="button" hidden>Try again</button>
    </div>
  </section>`;
  const input = dialog.querySelector<HTMLInputElement>("[data-confirmation]")!;
  const label = dialog.querySelector<HTMLElement>("[data-confirmation-label]")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("[data-cancel]")!;
  const submit = dialog.querySelector<HTMLButtonElement>("[data-submit]")!;
  const done = dialog.querySelector<HTMLButtonElement>("[data-done]")!;
  const retry = dialog.querySelector<HTMLButtonElement>("[data-retry]")!;
  const status = dialog.querySelector<HTMLElement>("[data-status]")!;
  const confirmBody = dialog.querySelector<HTMLElement>("[data-confirm-body]")!;
  const pendingUpload = dialog.querySelector<HTMLElement>("[data-pending-upload-notice]")!;
  const ownerless = dialog.querySelector<HTMLElement>("[data-ownerless-notice]")!;
  confirmBody.textContent = ACCOUNT_SELF_DELETE_MESSAGES.confirmBody;
  pendingUpload.textContent = ACCOUNT_SELF_DELETE_MESSAGES.pendingUploadNotice;
  ownerless.textContent = ACCOUNT_SELF_DELETE_MESSAGES.practiceLeftOwnerlessNotice;
  let disposed = false;

  const render = (state: AccountSelfDeleteState): void => {
    if (disposed) return;
    const editable = state.phase === "confirming" || (state.phase === "failed" && state.completion === null);
    const finished = state.phase === "complete" || state.phase === "local_clear_failed";
    label.hidden = !editable;
    input.disabled = !editable;
    if (input.value !== state.confirmation) input.value = state.confirmation;
    submit.hidden = finished || state.phase === "clearing" || state.phase === "submitting" || state.retryable;
    submit.disabled = !editable || state.confirmation !== "DELETE" || state.retryable;
    cancel.hidden = state.phase === "submitting" || state.phase === "clearing" || finished;
    retry.hidden = !(state.phase === "failed" && state.retryable);
    done.hidden = !finished;
    ownerless.hidden = state.practiceLeftOwnerless !== true;
    status.dataset.kind = state.error ? "error" : "";
    status.textContent = state.phase === "submitting" ? "Deleting your Cosmaneura account…"
      : state.phase === "clearing" ? "Clearing this device and signing out…"
      : state.phase === "complete" && state.completion === "deleted" ? ACCOUNT_SELF_DELETE_MESSAGES.deleted
      : state.phase === "complete" && state.completion === "session_expired" ? ACCOUNT_SELF_DELETE_MESSAGES.sessionExpired
      : state.phase === "complete" && state.completion === "gone" ? ACCOUNT_SELF_DELETE_MESSAGES.gone
      : state.error ?? "";
  };

  const flow = accountSelfDelete(host, render);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    flow.dispose();
    dialog.close();
    dialog.remove();
    if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus();
  };

  input.addEventListener("input", () => flow.confirm(input.value));
  cancel.addEventListener("click", () => { if (flow.cancel()) dispose(); });
  submit.addEventListener("click", () => { void flow.submit(); });
  retry.addEventListener("click", () => { void flow.submit(); });
  done.addEventListener("click", () => { if (flow.acknowledge()) dispose(); });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    const phase = flow.read().phase;
    if (phase === "complete" || phase === "local_clear_failed") {
      if (flow.acknowledge()) dispose();
      return;
    }
    if (flow.cancel()) dispose();
  });
  parent.append(dialog);
  dialog.showModal();
  render(flow.read());
  input.focus();
  return dispose;
}
