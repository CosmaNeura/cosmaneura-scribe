import { expect, it } from "vitest";
import { consentScript, recordingPreparationMarkup } from "./recording-preparation-view";

it("requires a fresh unchecked consent confirmation for each start screen", () => {
  const html = recordingPreparationMarkup({ isIOS: true, language: "en-US", modality: "in_person", audio: "microphone" });
  expect(html).toContain('name="consent" type="checkbox"');
  expect(html).not.toContain('type="checkbox" checked');
  expect(html).toContain('aria-describedby="provider-start-consent" disabled');
  expect(html).toContain("The patient said yes");
  expect(html).not.toContain("Where is the patient?");
});
it("uses the requested room/call consent scripts and Spanish wording", () => {
  expect(consentScript(false, false)).toContain("use a recorder");
  expect(consentScript(false, true)).toContain("record our call");
  expect(consentScript(true, true)).toContain("grabar nuestra llamada");
  expect(consentScript(true, false)).toContain("usar una grabadora");
});
