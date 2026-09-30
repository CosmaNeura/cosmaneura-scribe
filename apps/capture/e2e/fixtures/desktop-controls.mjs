// Presentation-only controller for an invented, consented visit. No media,
// storage, account, native helper, or network operations are implemented.
/* global document, window */
import "../../src/capture-app.ts";
import "../../src/styles.css";
import "../../src/provider/workspace.css";

const sessionId = "40000000-0000-4000-8000-000000000004";
const abort = new AbortController(), listeners = new Set(), commands = [];
let finishChoice;
let snapshot = { sessionId, state: "ready", statusCode: "capture_ready", recordedChunks: 0,
  queuedChunks: 0, elapsedSeconds: 0, remainingBudgetSeconds: null, remainingAuthoritySeconds: null,
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
  refreshTranscriptionStatus: forbidden,
};
const app = document.createElement("cosmaneura-capture");
app.bindProvider({ sessionId, controller, sourceKind: "microphone", captureMode: "desktop_meeting",
  languageMode: "english", signal: abort.signal, authorizedRequest: forbidden,
  journal: { load: forbidden, save: forbidden }, deactivate: async () => {} });
const root = document.querySelector("#provider");
root.classList.add("provider-workspace");
root.innerHTML = '<p class="provider-account">Local synthetic · Signed in as provider@example.invalid</p><header class="provider-header"><div><strong>Cosmaneura Scribe</strong><p data-provider-encounter>Invented visit — no real patient</p></div><button disabled>Your encounters</button></header>';
root.append(app);
window.desktopControlsLab = {
  commands,
  choose: () => {
    emit({ state: "recording", statusCode: "capture_recording", elapsedSeconds: 83, recordedChunks: 8 },
      { phase: "recording", coverage: "aligned" });
    finishChoice();
  },
  close: () => abort.abort(),
};
