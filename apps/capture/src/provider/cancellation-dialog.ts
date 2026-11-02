import type { CancellationPreview, CancellationReceipt, ScribeCancellation } from "./cancellation";
import "./cancellation-dialog.css";

/** Cancellation closes capture first. The dialog never deletes a shared login,
 * claims completed destruction, or selects another doctor/practice. */
export function openCancellationDialog(root: HTMLElement, cancellation: ScribeCancellation,
  closeWorkspace: () => Promise<void>, accepted: (receipt: CancellationReceipt) => void,
  openDashboard?: (signal: AbortSignal) => Promise<void>): () => void {
  const abort = new AbortController(), dialog = document.createElement("dialog");
  dialog.className = "scribe-cancellation-dialog";
  dialog.innerHTML = `<h2>Cancel Scribe access</h2><p data-cancel-status role="status"></p>
    <div data-cancel-details><p>Your Cosmaneura sign-in stays active. Cancellation stops new recording and processing for your account.</p>
    <p>You have a read-only/export period before the account’s Scribe and Core health information is scheduled for destruction. Other practice members keep their access.</p>
    <p>Destruction requires a reviewed record inventory and a certificate. Neither is complete when you submit this request. De-identified data follows your BAA. Audit, BAA and compliance records are retained six years; financial and contract records seven years.</p>
    <label>Type CANCEL to confirm <input data-cancel-confirm autocomplete="off" spellcheck="false"></label></div>
    <div class="scribe-cancellation-actions"><button data-cancel-submit disabled>Confirm cancellation</button><button data-cancel-retry hidden>Check again</button><button data-cancel-dashboard hidden>Open dashboard to read or export</button><button data-cancel-close>Back</button></div>`;
  root.append(dialog);
  const status = dialog.querySelector<HTMLElement>("[data-cancel-status]")!;
  const input = dialog.querySelector<HTMLInputElement>("[data-cancel-confirm]")!;
  const submit = dialog.querySelector<HTMLButtonElement>("[data-cancel-submit]")!;
  const retry = dialog.querySelector<HTMLButtonElement>("[data-cancel-retry]")!;
  const dashboard = dialog.querySelector<HTMLButtonElement>("[data-cancel-dashboard]")!;
  const details = dialog.querySelector<HTMLElement>("[data-cancel-details]")!;
  let preview: CancellationPreview | null = null, busy = false, submitted = false;
  const alive = (): boolean => !abort.signal.aborted;
  const renderReceipt = (receipt: CancellationReceipt): void => {
    submitted = true; preview = null; details.hidden = true; submit.hidden = true;
    retry.hidden = false; retry.textContent = "Refresh status";
    dashboard.hidden = receipt.phase !== "read-only-export" || !openDashboard;
    status.textContent = receipt.phase === "read-only-export"
      ? `Cancellation recorded. Your account is read-only through ${new Date(receipt.export_until).toLocaleDateString()}. Open the dashboard to read or export your existing records. Destruction has not been completed.`
      : "Your export window has ended. New processing remains disabled. Record destruction and its certificate have not been completed.";
    accepted(receipt);
  };
  const failed = (): void => {
    status.textContent = submitted
      ? "Cancellation could not be confirmed. Your original request is retained. Check again before submitting anything else."
      : "Cancellation is unavailable or could not be checked. No cancellation has been confirmed. You can check again or go back.";
    retry.hidden = false; submit.disabled = true;
  };
  const load = async (): Promise<void> => {
    if (busy || !alive()) return; busy = true; status.textContent = "Checking your account…";
    try {
      const result = await cancellation.load(abort.signal); if (!alive()) return;
      if (result.action !== "preview") {
        submitted = true; await closeWorkspace(); if (alive()) renderReceipt(result);
      }
      else {
        preview = result; status.textContent = `Your read-only/export period is ${result.grace_days} days. Review the request before confirming.`;
        retry.hidden = true; submit.disabled = input.value !== "CANCEL";
      }
    } catch { if (alive()) failed(); } finally { busy = false; }
  };
  const send = async (): Promise<void> => {
    if (busy || !preview || input.value !== "CANCEL" || !alive()) return;
    busy = true; submit.disabled = true; retry.hidden = true; status.textContent = "Closing recording before cancellation…";
    try {
      await closeWorkspace(); if (!alive()) return;
      submitted = true; status.textContent = "Submitting your cancellation…";
      const result = await cancellation.submit(preview, abort.signal); if (alive()) renderReceipt(result);
    } catch { if (alive()) failed(); } finally { busy = false; }
  };
  input.addEventListener("input", () => { submit.disabled = busy || submitted || !preview || input.value !== "CANCEL"; });
  submit.addEventListener("click", () => { void send(); });
  retry.addEventListener("click", () => { void load(); });
  dashboard.addEventListener("click", () => {
    if (busy || !alive() || dashboard.hidden || !openDashboard) return;
    busy = true; dashboard.disabled = true;
    void openDashboard(abort.signal).catch(() => { if (alive()) status.textContent = "The dashboard could not be opened. Try again or use your existing Cosmaneura sign-in."; })
      .finally(() => { busy = false; dashboard.disabled = false; });
  });
  const dispose = (): void => { abort.abort(); dialog.remove(); };
  dialog.querySelector("[data-cancel-close]")!.addEventListener("click", dispose);
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); else dispose(); });
  dialog.showModal(); void load(); return dispose;
}
