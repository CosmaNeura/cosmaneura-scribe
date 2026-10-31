import type { EncounterSetupState } from "./encounter-setup";

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Search and creation share the same entered name; choosing an existing chart stays explicit. */
export function encounterSetupMarkup(state: EncounterSetupState, query = "", existingPatientOnly = false): string {
  const back = '<button data-workspace-action="encounters">Today’s patients</button>';
  if (state.pending) {
    return `<h1>Finish creating your visit</h1><p>A previous creation request is saved securely on this device. Check its result before starting another visit.</p>
      <button data-workspace-action="retry-creation">${state.pending.openAfterCreation === false ? "Check visit creation" : "Check and open visit"}</button>${back}`;
  }
  if (existingPatientOnly) {
    return `<section class="provider-setup"><h1>New visit for an existing patient</h1>
      <form data-existing-patient-search><label>Find your patient<input name="existing-patient-query" maxlength="200" value="${escape(query)}" autocomplete="off"></label><button type="submit">Search patients</button></form>
      <p>Check the patient’s details before choosing.</p>
      ${state.patients.map(patient => `<button data-workspace-action="select-patient" data-patient="${escape(patient.patientRef)}"><strong>${escape(patient.name)}</strong><span>${patient.dateOfBirth ? `DOB ${escape(patient.dateOfBirth)}` : "DOB not provided"}</span></button>`).join("")}
      ${state.patients.length ? "" : "<p>No matching patients found.</p>"}
      ${state.moreResults ? "<p>More patients match. Narrow your search.</p>" : ""}${back}</section>`;
  }
  return `<section class="provider-setup"><h1>Add a patient visit</h1>
    <form data-walk-in><label>Patient’s name<input name="walk-in-name" maxlength="200" value="${escape(query.trim())}" placeholder="First and last name" autocomplete="off" required></label>
    <p class="provider-start-help">A name is enough to start. You can match the patient using date of birth and other details later.</p>
    <div class="provider-create-actions"><button type="submit" class="provider-primary">Continue to recording setup</button>
      <button type="submit" data-create-only aria-describedby="provider-create-only-help">Create visit only</button>
      <p id="provider-create-only-help" class="provider-start-help">Use another recording method? Create the visit now, then link a Zoom meeting from Schedule in Cosmas.</p>
      <button type="button" class="provider-text-link" data-workspace-action="encounters">Cancel</button></div></form></section>`;
}
