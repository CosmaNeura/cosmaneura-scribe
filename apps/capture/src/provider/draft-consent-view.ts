import { consentScript } from "./recording-preparation-view";

const escape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Only a durably retained draft is shown here. This checkbox is local intent;
 * neither it nor this screen can admit, acquire or start a recorder. */
export function draftConsentMarkup(name: string, spanish: boolean): string {
  return `<section class="provider-preparation provider-draft-consent" data-draft-consent>
    <h1>Confirm recording consent</h1><p class="provider-draft-patient">${escape(name)}</p>
    <div class="provider-start-action"><p class="provider-preparation-label">Ask the patient:</p>
    <blockquote class="provider-consent-script">${escape(consentScript(spanish, false))}</blockquote>
    <label class="provider-consent"><input name="draft-consent" type="checkbox">The patient said yes</label>
    <button class="provider-primary" aria-describedby="provider-draft-status" disabled>Start recording</button>
    <p class="provider-consent-explanation" id="provider-draft-status" role="status">Preparing your visit. Recording has not started.</p>
    <button class="provider-text-link" data-workspace-action="cancel-patient-creation">Cancel preparation</button></div></section>`;
}
