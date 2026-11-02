import { accountSelfDelete, type AccountSelfDeleteHost, type AccountSelfDeleteState } from "./account-self-delete";
import "./account-self-delete-dialog.css";

/** Full-screen confirm for Account > Delete account (Apple 5.1.1(v)). */
export function mountAccountSelfDeleteDialog(parent: HTMLElement, host: AccountSelfDeleteHost): () => void {
  const priorFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "scribe-account-self-delete";
  dialog.setAttribute("aria-labelledby", "scribe-account-self-delete-title");
  dialog.innerHTML = `<section>
    <h1 id="scribe-account-self-delete-title">Delete your account?</h1>
    <p>This permanently deletes your whole Cosmaneura sign-in, including Cosmas web access, and your personal Scribe data on this account. This cannot be undone.</p>
    <p>Your practice and your colleagues' data are not deleted.</p>
    <label data-confirmation-label>Type DELETE to confirm
      <input data-confirmation autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Type DELETE to confirm">
    </label>
    <p data-status role="status" aria-live="polite"></p>
    <div class="scribe-self-delete-actions">
      <button data-cancel type="button">Cancel</button>
      <button data-submit type="button" disabled>Delete account</button>
    </div>
  </section>`;
  const input = dialog.querySelector<HTMLInputElement>("[data-confirmation]")!;
  const label = dialog.querySelector<HTMLElement>("[data-confirmation-label]")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("[data-cancel]")!;
  const submit = dialog.querySelector<HTMLButtonElement>("[data-submit]")!;
  const status = dialog.querySelector<HTMLElement>("[data-status]")!;
  let disposed = false;

  const render = (state: AccountSelfDeleteState): void => {
    if (disposed) return;
    const editable = state.phase === "confirming" || state.phase === "failed";
    label.hidden = !editable;
    input.disabled = state.phase !== "confirming" && state.phase !== "failed";
    if (input.value !== state.confirmation) input.value = state.confirmation;
    submit.disabled = !editable || state.confirmation !== "DELETE";
    submit.hidden = state.phase === "complete" || state.phase === "clearing";
    cancel.hidden = state.phase === "submitting" || state.phase === "clearing" || state.phase === "complete";
    status.dataset.kind = state.error ? "error" : "";
    status.textContent = state.phase === "submitting" ? "Deleting your Cosmaneura account…"
      : state.phase === "clearing" ? "Clearing this device and signing out…"
      : state.phase === "complete" ? "Your account has been deleted."
      : state.error ?? "";
    if (state.phase === "complete") {
      cancel.hidden = true;
      submit.hidden = true;
      label.hidden = true;
      window.setTimeout(() => dispose(), 600);
    }
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
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    if (flow.cancel()) dispose();
  });
  parent.append(dialog);
  dialog.showModal();
  render(flow.read());
  input.focus();
  return dispose;
}
