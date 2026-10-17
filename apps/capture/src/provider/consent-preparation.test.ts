import { expect, it, vi } from "vitest";
import type { ProviderRecorderController, ProviderRecorderSnapshot } from "../provider-binding";
import { configureConsentedRecorder, consentPreparationEnabled, type ConsentedSourceChoice } from "./consent-preparation";

// Fictional parties explicitly consented. Only metadata selection runs; there
// is no audio driver, native device, SDK, network or recording implementation.
const sessionId = "00000000-0000-4000-8000-000000000001";
const release = { enabled: true, owner: "John Clemente", cohort: "internal", expires: "2026-11-01" } as const;
it("defaults off and requires the exact owner, cohort and unexpired release", () => {
  expect(consentPreparationEnabled(undefined)).toBe(false);
  expect(consentPreparationEnabled(release, Date.parse("2026-10-17T00:00:00Z"))).toBe(true);
  expect(consentPreparationEnabled({ ...release, enabled: false })).toBe(false);
  expect(consentPreparationEnabled(release, Date.parse("2026-11-01T00:00:00Z"))).toBe(false);
  expect(consentPreparationEnabled(release, NaN)).toBe(false);
});
function fixture(preparing = false) {
  let snapshot: ProviderRecorderSnapshot = { sessionId, state: preparing ? "preparing" : "ready", statusCode: "capture_ready",
    recordedChunks: 0, queuedChunks: 3, elapsedSeconds: 0, remainingBudgetSeconds: 900, remainingAuthoritySeconds: 900,
    transcript: null, transcriptionStatus: null, selectedInputId: "built-in-fixture",
    inputDevices: [{ id: "named-fixture", label: "Invented microphone", kind: "external", current: true }],
    desktop: { phase: preparing ? "preparing" : "ready", audioMode: "microphone", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null,
      meetingWindows: { state: "ready", selectedId: null, windows: [{ id: "call-fixture", title: "Invented call" }] } } };
  const listeners = new Set<(s: ProviderRecorderSnapshot) => void>();
  const publish = (change: Partial<ProviderRecorderSnapshot>) => { snapshot = { ...snapshot, ...change }; for (const fn of listeners) fn(snapshot); };
  const startRecording = vi.fn(), resumeRecording = vi.fn();
  const selectAudioInput = vi.fn(async (id: string) => publish({ selectedInputId: id }));
  const selectDesktopAudio = vi.fn(async (audioMode: "microphone" | "meeting") => publish({ desktop: { ...snapshot.desktop!, audioMode } }));
  const selectMeetingWindow = vi.fn(async (selectedId: string) => publish({ desktop: { ...snapshot.desktop!, meetingWindows: { ...snapshot.desktop!.meetingWindows!, selectedId } } }));
  const controller = { get snapshot() { return snapshot; }, subscribe(fn: (s: ProviderRecorderSnapshot) => void) { listeners.add(fn); fn(snapshot); return () => { listeners.delete(fn); }; },
    startRecording, resumeRecording, selectAudioInput, selectDesktopAudio, selectMeetingWindow,
  } as unknown as ProviderRecorderController;
  const abort = new AbortController(); let current = true;
  const choice: ConsentedSourceChoice = { microphone: "external", inputId: "named-fixture", desktopAudio: "meeting", meetingWindowId: "call-fixture", signal: abort.signal };
  return { controller, choice, abort, publish, listeners, startRecording, resumeRecording, selectAudioInput, selectDesktopAudio, selectMeetingWindow, current: () => current, revoke: () => { current = false; abort.abort(); } };
}
it.each([false, true])("transfers microphone/call configuration after preparation=%s without recording", async preparing => {
  const f = fixture(preparing); const pending = configureConsentedRecorder(f.controller, f.choice, f.current);
  if (preparing) { expect(f.selectAudioInput).not.toHaveBeenCalled(); f.publish({ state: "ready", desktop: { ...f.controller.snapshot.desktop!, phase: "ready" } }); }
  expect(await pending).toBe(true);
  expect(f.selectAudioInput).toHaveBeenCalledWith("named-fixture");
  expect(f.selectMeetingWindow).toHaveBeenCalledWith("call-fixture");
  expect(f.startRecording).not.toHaveBeenCalled(); expect(f.resumeRecording).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
});
it("joins delayed preparation and discards configuration on cancellation", async () => {
  const f = fixture(true); const pending = configureConsentedRecorder(f.controller, f.choice, f.current); f.abort.abort();
  expect(await pending).toBe(false); expect(f.listeners.size).toBe(0);
  f.publish({ state: "ready" }); expect(f.selectAudioInput).not.toHaveBeenCalled(); expect(f.startRecording).not.toHaveBeenCalled();
});
it.each(["input", "mode", "call"])("fences account/visit cancellation during %s configuration", async operation => {
  const f = fixture(); const method = { input: "selectAudioInput", mode: "selectDesktopAudio", call: "selectMeetingWindow" }[operation] as "selectAudioInput";
  vi.mocked(f[method]).mockImplementationOnce(async () => { f.revoke(); });
  await expect(configureConsentedRecorder(f.controller, f.choice, f.current)).rejects.toThrow("consent_preparation_scope_changed");
  expect(f.startRecording).not.toHaveBeenCalled();
});
it.each(["recorded", "elapsed", "coverage", "different-session", "missing-input", "missing-call"])("refuses %s without starting", async reason => {
  const f = fixture(reason === "different-session");
  if (reason === "recorded") f.publish({ recordedChunks: 1 });
  if (reason === "elapsed") f.publish({ elapsedSeconds: 1 });
  if (reason === "coverage") f.publish({ desktop: { ...f.controller.snapshot.desktop!, coverage: "complete" } });
  if (reason === "missing-input") f.publish({ inputDevices: [] });
  if (reason === "missing-call") f.publish({ desktop: { ...f.controller.snapshot.desktop!, meetingWindows: { state: "ready", selectedId: null, windows: [] } } });
  const result = configureConsentedRecorder(f.controller, f.choice, f.current);
  if (reason === "different-session") f.publish({ sessionId: "00000000-0000-4000-8000-000000000002", state: "ready", desktop: { ...f.controller.snapshot.desktop!, phase: "ready" } });
  await expect(result).rejects.toThrow(); expect(f.startRecording).not.toHaveBeenCalled();
});
it("does not extend expired authority or start on delayed readiness", async () => {
  const f = fixture(true); const result = configureConsentedRecorder(f.controller, f.choice, f.current);
  f.publish({ state: "ready", remainingAuthoritySeconds: 0, desktop: { ...f.controller.snapshot.desktop!, phase: "ready" } });
  expect(await result).toBe(true); expect(f.controller.snapshot.remainingAuthoritySeconds).toBe(0); expect(f.startRecording).not.toHaveBeenCalled();
});
it("leaves inactive iPhone system input to the authorized recorder when metadata has no named device", async () => {
  const f = fixture(); f.publish({ desktop: undefined } as unknown as Partial<ProviderRecorderSnapshot>);
  expect(await configureConsentedRecorder(f.controller, { microphone: "built_in", signal: f.abort.signal }, f.current)).toBe(true);
  expect(f.selectAudioInput).not.toHaveBeenCalled(); expect(f.startRecording).not.toHaveBeenCalled();
});
it("does not turn an already selected recommended call into a new explicit choice", async () => {
  const f = fixture();
  f.publish({ selectedInputId: "named-fixture", desktop: { ...f.controller.snapshot.desktop!, audioMode: "meeting",
    meetingWindows: { ...f.controller.snapshot.desktop!.meetingWindows!, selectedId: "call-fixture" } } });
  expect(await configureConsentedRecorder(f.controller, f.choice, f.current)).toBe(true);
  expect(f.selectAudioInput).not.toHaveBeenCalled(); expect(f.selectDesktopAudio).not.toHaveBeenCalled(); expect(f.selectMeetingWindow).not.toHaveBeenCalled();
  expect(f.startRecording).not.toHaveBeenCalled();
});
