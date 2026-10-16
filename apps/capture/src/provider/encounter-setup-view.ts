import type { EncounterSetupState } from "./encounter-setup";

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Search and creation share the same entered name; choosing an existing chart stays explicit. */
export function encounterSetupMarkup(state: EncounterSetupState, query = ""): string {
  const back = '<button data-workspace-action="encounters">Today’s patients</button>';
  if (state.pending) {
    return `<h1>Finish creating your visit</h1><p>A previous creation request is saved securely on this device. Check its result before starting another visit.</p>
      <button data-workspace-action="retry-creation">Check and open visit</button>${back}`;
  }
  return `<section class="provider-setup"><h1>Record a patient who isn’t on the schedule</h1>
    <form data-walk-in><label>Patient’s name<input name="walk-in-name" maxlength="200" value="${escape(query.trim())}" placeholder="First and last name" autocomplete="off" required></label>
    <p class="provider-start-help">A name is enough to start. You can match the patient using date of birth and other details later.</p>
    <div class="provider-create-actions"><button type="button" class="provider-text-link" data-workspace-action="encounters">Cancel</button><button type="submit" class="provider-primary">Continue to recording setup</button></div></form></section>`;
}
