import type { LanguageMode } from "./core-client";

export function consentScript(spanish: boolean, videoCall: boolean): string {
  return spanish ? videoCall
    ? "Voy a grabar nuestra llamada para poder concentrarme en usted — ¿está bien?"
    : "Voy a usar una grabadora para poder concentrarme en usted — ¿está bien?"
    : videoCall ? "I'm going to record our call so I can focus on you — is that okay?"
      : "I'm going to use a recorder so I can focus on you — is that okay?";
}

export function recordingPreparationMarkup(options: { isIOS: boolean; language: LanguageMode;
  modality: "in_person" | "virtual" | "phone"; audio: "microphone" | "meeting" }): string {
  return `<section class="provider-preparation"><h1>Start recording</h1>
    <p class="provider-audio-summary"><span data-audio-summary></span><button type="button" data-change-audio>Change</button></p>
    ${options.isIOS ? '' : `<p>Where is the patient?</p><div class="provider-source-cards">
      <button type="button" data-preparation-audio="microphone" aria-pressed="${options.audio === "microphone"}"><strong>In the room</strong><small>Uses this Mac's microphone</small></button>
      <button type="button" data-preparation-audio="meeting" aria-pressed="${options.audio === "meeting"}"><strong>On a video call</strong><small>Zoom, Google Meet or similar</small></button></div>`}
    <select name="modality" hidden><option value="in_person"${options.modality === "in_person" ? " selected" : ""}>In person</option><option value="virtual"${options.modality === "virtual" ? " selected" : ""}>Video call</option><option value="phone"${options.modality === "phone" ? " selected" : ""}>Phone call</option></select>
    ${options.isIOS ? '' : `<select name="desktop-audio" hidden><option value="microphone"${options.audio === "microphone" ? " selected" : ""}>Microphone</option><option value="meeting"${options.audio === "meeting" ? " selected" : ""}>Microphone and call audio</option></select>`}
    <p class="provider-start-help" data-recording-guidance role="status"></p>
    <div class="provider-microphone-check"><span data-preflight-verdict role="status">Checking recording access…</span></div>
    <button type="button" class="provider-text-link" data-preflight-access>Check recording access</button>
    <p data-preflight-access-help>Microphone levels appear after consent and recording starts.</p>
    ${options.isIOS ? '' : `<div data-preflight-meeting hidden>
      <div class="provider-call-summary" data-preflight-call-summary aria-live="polite"><div><strong data-preflight-call-heading>Choose your call</strong><span data-preflight-call-title></span></div><button type="button" class="provider-text-link" data-preflight-call-change aria-expanded="false" aria-controls="provider-call-picker">Choose call</button></div>
      <div class="provider-call-picker" id="provider-call-picker" data-preflight-call-picker hidden><label>Which call?<select data-preflight-window><option value="">Choose your Zoom or Chrome window</option></select></label><div class="provider-call-picker-actions"><button type="button" class="provider-text-link" data-preflight-refresh>Refresh calls</button><button type="button" class="provider-text-link" data-preflight-call-done>Done</button></div></div>
      <p data-preflight-window-help role="status"></p></div>`}
    <p>Say to the patient:</p><blockquote class="provider-consent-script" data-consent-script></blockquote>
    <label class="provider-consent"><input name="consent" type="checkbox">The patient said yes</label>
    <button data-workspace-action="prepare" aria-describedby="provider-start-consent" disabled>Start recording</button>
    <p class="provider-consent-explanation" id="provider-start-consent">Recording starts after you confirm consent.</p>
    <p data-recording-preparation-status role="status" hidden></p>
    <button class="provider-text-link" data-workspace-action="cancel-recording-action" hidden>Cancel</button>
    <dialog class="provider-audio-dialog" data-audio-settings aria-labelledby="provider-audio-title"><h2 id="provider-audio-title">Language and microphone</h2>
      <div class="provider-recording-fields"><label>What language is the visit in?<select name="language"><option value="en-US"${options.language === "en-US" ? " selected" : ""}>English · note in English</option><option value="en-US+es-US"${options.language === "en-US+es-US" ? " selected" : ""}>Spanish and English · note in English</option></select></label>
      <label>Which microphone?<select data-preflight-input><option value="">Checking available microphones…</option></select></label><input name="microphone" value="built_in" type="hidden"></div>
      <p>Scribe remembers your settings for next time.</p><button class="provider-primary" type="button" data-audio-done>Done</button></dialog>
  </section><p class="provider-support">Still stuck? Email <a href="mailto:dev@cosmaneura.com">dev@cosmaneura.com</a></p>`;
}
