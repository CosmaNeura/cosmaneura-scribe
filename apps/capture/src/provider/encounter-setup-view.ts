import type { EncounterSetupState } from "./encounter-setup";

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** The same small setup screen is rendered in the mobile and desktop shells. */
export function encounterSetupMarkup(state: EncounterSetupState, query = ""): string {
  const back = '<button data-workspace-action="encounters">Your encounters</button>';
  if (state.pending) {
    return `<h1>Finish creating your encounter</h1><p>A previous creation request is saved securely on this device. Check its result before starting another visit.</p>
      <button data-workspace-action="retry-creation">Check and open encounter</button>${back}`;
  }
  return `<section class="provider-setup"><div class="provider-list-heading"><h1>New encounter</h1>${back}</div>
    <p>Choose a patient to create a visit for today. Recording starts only after you confirm consent.</p>
    <form data-patient-search><label>Find a patient<input name="patient-query" type="search" maxlength="200" value="${escape(query)}" autocomplete="off"></label><button type="submit">Search</button></form>
    <ul class="provider-encounters" aria-label="Choose patient">${state.patients.slice(0, 8).map(patient =>
      `<li><button data-workspace-action="select-patient" data-patient="${escape(patient.patientRef)}"><strong>${escape(patient.name)}</strong><span>Date of birth: ${escape(patient.dateOfBirth)} · New visit</span></button></li>`).join("")}</ul>
    ${state.moreResults || state.patients.length > 8 ? '<p>Search by name to narrow these results.</p>' : state.patients.length ? '' : '<p>No patients found. Search again or add a new patient below.</p>'}
    <details class="provider-recording-options"${state.patients.length ? '' : ' open'}><summary>Add a new patient</summary>
      <form data-new-patient><label>Patient name<input name="new-patient-name" autocomplete="off" maxlength="200" required></label>
      <label>Date of birth<input name="new-patient-dob" type="date" min="1900-01-01" max="${new Date().toLocaleDateString('en-CA')}" required></label>
      <p>Creates a new patient record. Choose an existing patient above if they already have one.</p>
      <button type="submit">Create encounter</button></form></details></section>`;
}
