// Presentation-only controller for an invented, consented visit. No media,
// storage, account, native helper, or network operations are implemented.
/* global document, window */
import "../../src/capture-app.ts";
import "../../src/styles.css";
import "../../src/provider/workspace.css";
import "../../src/provider/application.css";
import scribeIcon from "../../public/icon.svg?raw";

const sessionId = "40000000-0000-4000-8000-000000000004";
const abort = new AbortController(), listeners = new Set(), commands = [];
let finishChoice;
let snapshot = { sessionId, state: "ready", statusCode: "capture_ready", recordedChunks: 0,
  queuedChunks: 0, elapsedSeconds: 0, remainingBudgetSeconds: null, remainingAuthoritySeconds: 900,
  transcript: null, transcriptionStatus: null,
  desktop: { phase: "ready", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null } };
const emit = (fields, desktop = {}) => {
  snapshot = { ...snapshot, ...fields, desktop: { ...snapshot.desktop, ...desktop } };
  for (const listener of listeners) listener(structuredClone(snapshot));
};
const forbidden = () => { throw new Error("Real recording and services are forbidden in this fixture"); };
const controller = {
  get snapshot() { return structuredClone(snapshot); },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async startRecording() {
    commands.push("start");
    emit({ state: "recording", statusCode: "capture_window_selection_pending" }, { phase: "starting" });
    await new Promise(resolve => { finishChoice = resolve; });
  },
  async pauseRecording() {
    commands.push("pause"); emit({ state: "paused", statusCode: "capture_paused" }, { phase: "interrupted", coverage: "complete" });
  },
  async resumeRecording() {
    commands.push("resume"); emit({ state: "recording", statusCode: "capture_recording" }, { phase: "recording", coverage: "aligned" });
  },
  async stopRecording() {
    commands.push("stop");
    // Deliberately exercise failure recovery without permitting a second Start.
    emit({ state: "paused", statusCode: "capture_start_unconfirmed" }, { phase: "stop_unconfirmed" });
  },
  async showWindowChooser() { commands.push("show_chooser"); },
  refreshTranscriptionStatus: forbidden,
};
const app = document.createElement("cosmaneura-capture");
app.bindProvider({ sessionId, controller, sourceKind: "microphone", captureMode: "desktop_meeting",
  encounterLabel: "Avery Example", visitLabel: "Video visit",
  languageMode: "english", signal: abort.signal, authorizedRequest: forbidden,
  journal: { load: forbidden, save: forbidden }, deactivate: async () => {} });
const root = document.querySelector("#provider");
const application = document.createElement("div"); application.className = "provider-application";
root.replaceWith(application);
application.innerHTML = `<header class="provider-session-header"><div class="provider-brand"><span class="provider-brand-icon" aria-hidden="true">${scribeIcon}</span><strong>Scribe</strong></div><div data-session-actions><button data-session-action="sign-out" disabled>Sign out</button></div></header>`;
application.append(root);
root.classList.add("provider-workspace");
root.innerHTML = '<p class="provider-account">Local synthetic · Signed in as provider@example.invalid</p><header class="provider-header"><div><strong>Cosmaneura Scribe</strong><p data-provider-encounter>Invented visit — no real patient</p></div><button disabled>Your encounters</button></header>';
root.append(app);
window.desktopControlsLab = {
  commands,
  choose: () => {
    emit({ state: "recording", statusCode: "capture_recording", elapsedSeconds: 83, recordedChunks: 8 },
      { phase: "recording", coverage: "aligned", inputSignal: { microphone: { level: 0.125, ageMs: 0 }, meetingAudio: { level: 0.25, ageMs: 0 } } });
    finishChoice();
  },
  incomplete: () => emit({}, { coverage: "incomplete" }),
  confirming: () => emit({ state: "paused", statusCode: "capture_stop_acknowledgement_pending" }, { phase: "stopping" }),
  confirmationLost: () => emit({ state: "paused", statusCode: "capture_stop_acknowledgement_pending" }, { phase: "interrupted" }),
  settledPause: () => emit({ state: "paused", statusCode: "capture_paused" }, { phase: "interrupted" }),
  quiet: () => emit({}, { inputSignal: { microphone: { level: 0, ageMs: 0 }, meetingAudio: null } }),
  close: () => abort.abort(),
};
