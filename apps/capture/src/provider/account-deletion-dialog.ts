import { accountDeletion, type AccountDeletionHost, type AccountDeletionState } from "./account-deletion";
import "./account-deletion-dialog.css";

/** Not mounted by current hosts. A real self-only deletion adapter is required. */
export function mountAccountDeletionDialog(parent: HTMLElement, host: AccountDeletionHost): () => void {
  const priorFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "scribe-account-deletion";
  dialog.setAttribute("aria-labelledby", "scribe-account-deletion-title");
  dialog.innerHTML = `<section><h1 id="scribe-account-deletion-title">Delete your account?</h1>
    <p>This permanently deletes your Cosmaneura sign-in and your personal Scribe data. You will also lose access to the Cosmaneura platform. This cannot be undone.</p>
    <p>Your practice and your colleagues’ data are not deleted.</p>
    <p data-retention hidden>Clinical records your practice must keep remain with the practice.</p>
    <p data-last-owner hidden>You are the only owner of this practice. The practice stays, and support can reassign it.</p>
    <label data-confirmation-label>Type DELETE to confirm<input data-confirmation autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Type DELETE to confirm"></label>
    <p data-status role="status" aria-live="polite"></p>
    <div class="scribe-deletion-actions"><button data-cancel type="button">Cancel</button><button data-submit type="button" disabled>Delete account</button><button data-retry type="button" hidden>Retry</button></div>
    </section>`;
  const input = dialog.querySelector<HTMLInputElement>("[data-confirmation]")!;
  const label = dialog.querySelector<HTMLElement>("[data-confirmation-label]")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("[data-cancel]")!;
  const submit = dialog.querySelector<HTMLButtonElement>("[data-submit]")!;
  const retry = dialog.querySelector<HTMLButtonElement>("[data-retry]")!;
  const status = dialog.querySelector<HTMLElement>("[data-status]")!;
  let disposed = false;
  const render = (state: AccountDeletionState): void => {
    if (disposed) return;
    dialog.querySelector<HTMLElement>("[data-retention]")!.hidden = state.preview?.retainsPracticeRecords !== true;
    dialog.querySelector<HTMLElement>("[data-last-owner]")!.hidden = state.preview?.isSolePracticeOwner !== true;
    label.hidden = !state.preview || !["confirming", "failed"].includes(state.phase) || state.receipt !== null;
    input.disabled = state.phase !== "confirming";
    if (input.value !== state.confirmation) input.value = state.confirmation;
    submit.hidden = !label.hidden && state.phase === "failed" || label.hidden;
    submit.disabled = state.phase !== "confirming" || state.confirmation !== "DELETE";
    retry.hidden = !["pending", "failed"].includes(state.phase);
    cancel.hidden = ["submitting", "pending", "cleaning", "complete"].includes(state.phase) || state.requestSubmitted;
    status.textContent = state.phase === "loading" ? "Checking what will be deleted…"
      : state.phase === "submitting" ? "Submitting your deletion request…"
      : state.phase === "cleaning" ? "Finishing secure sign-out on this device…"
      : state.phase === "failed" ? state.preview ? "Deletion did not finish. Tap Retry." : "The deletion details could not be checked. Tap Retry."
      : state.phase === "pending" && state.receipt?.status === "pending"
        ? `Your deletion request is pending. Completion is scheduled by ${new Date(state.receipt.completionDeadline).toLocaleString()}. Tap Retry to check its status.`
        : state.phase === "complete" ? "Your account deletion is complete." : "";
  };
  const workflow = accountDeletion(host, render);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; workflow.dispose(); dialog.close(); dialog.remove();
    if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus();
  };
  input.addEventListener("input", () => workflow.confirm(input.value));
  cancel.addEventListener("click", () => { if (workflow.cancel()) dispose(); });
  submit.addEventListener("click", () => { void workflow.submit(); });
  retry.addEventListener("click", () => { void workflow.retry(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (workflow.cancel()) dispose(); });
  parent.append(dialog); dialog.showModal(); render(workflow.read()); void workflow.load();
  return dispose;
}
