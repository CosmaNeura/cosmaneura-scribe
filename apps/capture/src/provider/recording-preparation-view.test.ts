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

it("offers explicit access setup without a pre-consent level meter", () => {
  const html=recordingPreparationMarkup({isIOS:false,language:"en-US",modality:"virtual",audio:"meeting"});
  expect(html).toContain('type="button" class="provider-text-link" data-preflight-access');
  expect(html).toContain("Microphone levels appear after consent and recording starts.");
  expect(html).not.toContain("data-preflight-level");
  expect(html).not.toContain("Speak to check");
});

it("keeps the desktop call picker behind a separate explicit choice action", () => {
  const html = recordingPreparationMarkup({ isIOS: false, language: "en-US", modality: "virtual", audio: "meeting" });
  expect(html).toContain("data-preflight-call-heading>Choose your call");
  expect(html).toContain('data-preflight-call-change aria-expanded="false" aria-controls="provider-call-picker"');
  expect(html).toContain('data-preflight-call-picker hidden');
  expect(html).toContain("data-preflight-call-done>Done");
  expect(html).toContain('name="consent" type="checkbox"');
  expect(html).not.toContain('type="checkbox" checked');
  expect(html).toContain('aria-describedby="provider-start-consent" disabled');
  expect(recordingPreparationMarkup({ isIOS: true, language: "en-US", modality: "in_person", audio: "microphone" })).not.toContain("data-preflight-call");
});

it("keeps optional access details after consent and the primary Start action", () => {
  const html = recordingPreparationMarkup({ isIOS: false, language: "en-US", modality: "virtual", audio: "meeting" });
  const start = html.indexOf('data-workspace-action="prepare"');
  expect(html.indexOf('name="consent"')).toBeLessThan(start);
  expect(html.indexOf('data-preflight-details')).toBeGreaterThan(start);
  expect(html).toContain('data-preflight-required-access hidden');
  expect(html).toContain('data-preflight-repair hidden><summary>Show steps</summary><ol');
  expect(html).toContain('data-preflight-access-optional hidden');
  expect(html).not.toContain('type="checkbox" checked');
});
