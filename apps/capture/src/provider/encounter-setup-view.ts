import type { EncounterSetupState } from "./encounter-setup";

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Search and creation share the same entered name; choosing an existing chart stays explicit. */
export function encounterSetupMarkup(state: EncounterSetupState, query = "", creating = false): string {
  const back = '<button data-workspace-action="encounters">Your encounters</button>';
  if (state.pending) {
    return `<h1>Finish creating your visit</h1><p>A previous creation request is saved securely on this device. Check its result before starting another visit.</p>
      <button data-workspace-action="retry-creation">Check and open visit</button>${back}`;
  }
  const searched = query.trim().length > 0;
  const name = escape(query.trim());
  const today = new Date();
  const maxDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return `<section class="provider-setup"><div class="provider-list-heading"><h1>New visit</h1>${back}</div>
    <p>Choose a patient to create today’s visit. You’ll confirm recording consent next. Date of birth is optional.</p>
    <form data-patient-search><label>Patient name<input name="patient-query" type="search" maxlength="200" value="${name}" autocomplete="off" required></label><button type="submit">Find patient</button></form>
    ${state.patients.length ? `<h2 class="provider-results-heading" tabindex="-1">${searched ? "Matching patients" : "Recent patients"}</h2>` : ""}
    <ul class="provider-encounters" aria-label="Choose patient">${state.patients.slice(0, 8).map(patient =>
      `<li><button data-workspace-action="select-patient" data-patient="${escape(patient.patientRef)}"><strong>${escape(patient.name)}</strong><span>${patient.dateOfBirth === null ? 'DOB not provided' : `DOB: ${escape(patient.dateOfBirth)}`}</span><span>Create visit for this patient</span></button></li>`).join("")}</ul>
    ${state.moreResults || state.patients.length > 8 ? '<p>Use more of the name to narrow these results.</p>' : searched && !state.patients.length ? '<p>No matching patients found.</p>' : ""}
    ${searched ? `<button class="provider-create-choice" data-workspace-action="new-patient" aria-expanded="${creating}" aria-controls="provider-new-patient">${creating ? "Hide new patient details" : `Create new patient: ${name}`}</button>` : '<p class="provider-start-help">Enter a name to find a chart or create a new patient.</p>'}
    ${creating ? `<section id="provider-new-patient" class="provider-new-patient" aria-labelledby="provider-new-patient-title"><h2 id="provider-new-patient-title" tabindex="-1">New patient: ${name}</h2>
      <p>This creates a new patient record. If this patient already has a record, choose it from the search results.</p>
      <form data-new-patient><input name="new-patient-name" type="hidden" value="${name}">
      <label>Date of birth (optional)<input name="new-patient-dob" type="date" min="1900-01-01" max="${maxDate}" aria-describedby="provider-dob-help"></label>
      <small id="provider-dob-help">You can record without it. Ask at the start of the visit.</small>
      <div class="provider-create-actions"><button type="submit">Create patient &amp; visit</button></div></form>
      <button data-workspace-action="patient-results">Cancel new patient</button></section>` : ""}
    </section>`;
}
