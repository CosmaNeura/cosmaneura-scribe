import type { ProviderEncounter } from "./workspace-contracts";
import type { ProviderEncounterSetup } from "./encounter-setup";
import type { PatientIdentity, PatientSelection } from "./visit-features";
import { validPatientDateOfBirth } from "./visit-features";
import { escapeText } from "./visit-list-view";

export interface PendingPatientMatch { key: string; expectedVersion: number; selection: PatientSelection }
export function mountPatientMatch(container: HTMLElement, options: {
  encounter: ProviderEncounter; setup: ProviderEncounterSetup; signal: AbortSignal;
  local(): PendingPatientMatch | null;
  retain(value: PendingPatientMatch | null): Promise<void>;
  updated(identity: PatientIdentity): void;
  purpose?: "new-visit";
}): () => void {
  const pending = options.local();
  const invalidPending = pending?.selection.kind === "confirm_new" && !validPatientDateOfBirth(pending.selection.dateOfBirth);
  container.innerHTML = `<dialog class="provider-unsaved-dialog" aria-labelledby="patient-match-title"><h2 id="patient-match-title">Match this patient</h2>
    <p>${options.purpose === "new-visit" ? "Confirm the patient’s details before starting a separate visit. The earlier visit and recording stay unchanged." : "You can save and review the note before matching. Confirm the patient’s details before linking a record."}</p>
    <form data-match-search><label>Patient name or identifying details<input name="match-query" value="${escapeText(options.encounter.identity?.name ?? options.encounter.patientName ?? options.encounter.title)}" maxlength="200" autocomplete="off"></label><label>Date of birth (optional)<input name="match-dob" type="date" min="1900-01-01" max="${new Date().toISOString().slice(0, 10)}"></label><button type="submit">Find patient</button></form>
    <div data-match-results></div><p data-match-status role="status">${invalidPending ? "The saved request has an invalid date of birth. Review the date before matching." : pending ? "A previous match isn’t confirmed yet. Try again to check the same request." : ""}</p>
    ${invalidPending ? '<button data-match-correct>Correct patient details</button>' : pending ? '<button data-match-retry>Try again</button>' : '<button class="provider-text-link" data-match-new>Keep this as a new patient</button>'}
    <button class="provider-text-link" data-match-close>Match later</button></dialog>`;
  const dialog = container.querySelector<HTMLDialogElement>("dialog")!, status = container.querySelector<HTMLElement>("[data-match-status]")!;
  const form = container.querySelector<HTMLFormElement>("form")!, results = container.querySelector<HTMLElement>("[data-match-results]")!;
  const dobInput = form.querySelector<HTMLInputElement>('[name="match-dob"]')!;
  if (invalidPending && pending.selection.kind === "confirm_new") dobInput.value = pending.selection.dateOfBirth ?? "";
  const validateDate = (dob: string | null): boolean => {
    if (validPatientDateOfBirth(dob)) return true;
    status.textContent = "Enter a valid date of birth from 1900 through today, or leave it blank."; dobInput.focus(); return false;
  };
  let identity = options.encounter.identity, closed = false, working = false;
  const active = (): boolean => !closed && !options.signal.aborted;
  const disabled = (busy: boolean): void => { working = busy; for (const button of dialog.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy; };
  const finish = (): void => { closed = true; dialog.close(); container.replaceChildren(); };
  const showCurrentMatch = async (): Promise<void> => {
    const pending = options.local();
    if (!pending || !options.setup.patientCandidates) return;
    const current = await options.setup.patientCandidates(options.encounter, "", null, options.signal);
    if (!active() || current.identity.version <= pending.expectedVersion) return;
    identity = current.identity;
    results.innerHTML = `<p>This visit now belongs to ${escapeText(identity.name)}${identity.dateOfBirth ? ` · DOB ${escapeText(identity.dateOfBirth)}` : ''}.</p><button data-match-current>Keep the current patient</button><button data-match-compare>Review another match</button>`;
    status.textContent = "The patient details changed on another device. Compare before choosing another record.";
  };
  const commit = async (selection?: PatientSelection): Promise<void> => {
    if (working || !active() || !options.setup.matchPatient) return;
    disabled(true);
    try {
      let request = options.local();
      const chosen = request?.selection ?? selection;
      if (chosen?.kind === "confirm_new" && !validateDate(chosen.dateOfBirth)) return;
      if (request && selection && JSON.stringify(request.selection) !== JSON.stringify(selection)) { status.textContent = "Check the previous match before choosing a different patient."; return; }
      if (!request) {
        if (!selection || !identity) return;
        request = { selection, expectedVersion: identity.version, key: crypto.randomUUID() };
        await options.retain(request);
      }
      if (!active()) return;
      const result = await options.setup.matchPatient(options.encounter, request.selection, request.expectedVersion, request.key, options.signal);
      if (!active()) return;
      await options.retain(null); if (!active()) return;
      options.updated(result.identity); finish();
    } catch {
      if (active()) { status.textContent = "The match isn’t confirmed yet. Your request is retained; try again to check it.";
        try { await showCurrentMatch(); } catch { /* Retain the exact unconfirmed request. */ }
      }
    }
    finally { if (active()) disabled(false); }
  };
  const search = async (event?: Event): Promise<void> => {
    event?.preventDefault(); if (working || !active() || !options.setup.patientCandidates || !validateDate(dobInput.value || null)) return;
    disabled(true); status.textContent = "Finding patients…";
    try {
      const query = form.querySelector<HTMLInputElement>('[name="match-query"]')!.value.trim(), dob = form.querySelector<HTMLInputElement>('[name="match-dob"]')!.value || null;
      const value = await options.setup.patientCandidates(options.encounter, query, dob, options.signal);
      if (!active()) return; identity = value.identity;
      results.innerHTML = value.patients.length ? `<p>Choose only after checking the patient’s details.</p>${value.patients.map(patient => `<button class="provider-match-result" data-match-patient="${escapeText(patient.patientRef)}"><strong>${escapeText(patient.name)}</strong><span>${patient.dateOfBirth ? `DOB ${escapeText(patient.dateOfBirth)}` : 'DOB not provided'}</span><span>Match this patient</span></button>`).join("")}` : '<p>No matching records found. You can keep this as a new patient.</p>';
      status.textContent = value.moreResults ? "Enter more details to narrow these results." : "";
    } catch { if (active()) status.textContent = "We couldn’t find patients. Try again or match later."; }
    finally { if (active()) disabled(false); }
  };
  const click = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    if (!button || !dialog.contains(button)) return;
    if (working || button.disabled) return;
    if (button.hasAttribute("data-match-correct")) {
      disabled(true);
      void options.retain(null).then(() => {
        if (!active()) return;
        button.remove(); results.replaceChildren(); status.textContent = "Correct or clear the date, then choose a patient.";
        results.insertAdjacentHTML("afterend", '<button class="provider-text-link" data-match-new>Keep this as a new patient</button>');
        disabled(false); dobInput.focus();
      }).catch(() => { if (active()) { status.textContent = "The saved request could not be cleared. Try again."; disabled(false); } });
    }
    else if (button.hasAttribute("data-match-current") || button.hasAttribute("data-match-compare")) {
      const keep = button.hasAttribute("data-match-current"), expected = identity;
      if (!expected) return;
      disabled(true);
      void options.retain(null).then(() => {
        if (!active()) return;
        container.querySelector("[data-match-retry]")?.remove();
        if (keep) { options.updated(expected); finish(); }
        else {
          if (!container.querySelector("[data-match-new]")) results.insertAdjacentHTML("afterend", '<button class="provider-text-link" data-match-new>Keep this as a new patient</button>');
          disabled(false); void search();
        }
      }).catch(() => { if (active()) { status.textContent = "Your comparison could not be retained. Try again."; disabled(false); } });
    }
    else if (button.hasAttribute("data-match-close")) finish();
    else if (button.hasAttribute("data-match-retry")) void commit();
    else if (button.hasAttribute("data-match-new")) void commit({ kind: "confirm_new", dateOfBirth: form.querySelector<HTMLInputElement>('[name="match-dob"]')!.value || null });
    else if (button.dataset.matchPatient) void commit({ kind: "existing", patientRef: button.dataset.matchPatient });
  };
  const onSubmit = (event: Event): void => { void search(event); };
  form.addEventListener("submit", onSubmit); dialog.addEventListener("click", click);
  dialog.addEventListener("cancel", event => { event.preventDefault(); if (!working) finish(); });
  dialog.showModal();
  if (!pending) void search();
  return () => { closed = true; form.removeEventListener("submit", onSubmit); dialog.removeEventListener("click", click); dialog.close(); };
}
