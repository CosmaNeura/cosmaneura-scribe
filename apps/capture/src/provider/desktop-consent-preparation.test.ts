import { afterEach, expect, it, vi } from "vitest";
import { CaptureApp } from "../capture-app";
import type { ProviderCaptureBinding, ProviderRecorderController, ProviderRecorderSnapshot } from "../provider-binding";

// Run the real element's consent continuation with a synthetic recorder only.
// Rendering/OS audio are outside this unit; no microphone or meeting is opened.
vi.mock("../native/ios-input-meter", () => ({}));
vi.mock("../native/desktop-input-meter", () => ({}));
const sessionId = "00000000-0000-4000-8000-000000000001";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

function fixture(phase: "preparing" | "ready", audioMode: "microphone" | "meeting", missingDesktop = false) {
  let snapshot: ProviderRecorderSnapshot = {
    sessionId, state: phase, statusCode: phase === "ready" ? "capture_ready" : "capture_preparing",
    recordedChunks: 0, queuedChunks: 0, elapsedSeconds: 0,
    remainingBudgetSeconds: 900, remainingAuthoritySeconds: 900, transcript: null, transcriptionStatus: null,
    desktop: { phase, audioMode, coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null },
  };
  if (missingDesktop) delete (snapshot as { desktop?: ProviderRecorderSnapshot["desktop"] }).desktop;
  const listeners = new Set<(value: ProviderRecorderSnapshot) => void>();
  const startRecording = vi.fn(async () => undefined), deactivate = vi.fn(async () => undefined);
  const selectDesktopAudio = vi.fn(async (value: "microphone" | "meeting") => { snapshot = { ...snapshot, desktop: { ...snapshot.desktop!, audioMode: value } }; });
  const controller = {
    get snapshot() { return snapshot; }, subscribe(listener: (value: ProviderRecorderSnapshot) => void) {
      listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); };
    }, startRecording, selectDesktopAudio,
  } as unknown as ProviderRecorderController;
  const abort = new AbortController(), app = new CaptureApp();
  Object.defineProperty(app, "isConnected", { configurable: true, value: false });
  vi.spyOn(app, "requestUpdate").mockImplementation(() => undefined);
  const binding = { sessionId, controller, signal: abort.signal, sourceKind: "microphone", captureMode: "desktop_meeting", languageMode: "english", deactivate } as unknown as ProviderCaptureBinding;
  app.bindProvider(binding);
  Object.defineProperty(app, "isConnected", { configurable: true, value: true });
  Object.defineProperty(app, "querySelector", { configurable: true, value: () => null });
  cleanups.push(() => abort.abort());
  const ready = () => {
    snapshot = { ...snapshot, state: "ready", desktop: { ...snapshot.desktop!, phase: "ready" } };
    for (const listener of listeners) listener(snapshot);
  };
  return { app, abort, startRecording, selectDesktopAudio, ready, listeners };
}

it.each(["microphone", "meeting"] as const)("consent applies %s choice without starting a ready desktop recorder", async mode => {
  const f = fixture("ready", mode);
  await f.app.startFromProviderAction("built_in", mode);
  expect(f.selectDesktopAudio).toHaveBeenCalledWith(mode);
  expect(f.startRecording).not.toHaveBeenCalled();
});

it.each(["microphone", "meeting"] as const)("late preparation never automatically starts %s recording", async mode => {
  const f = fixture("preparing", mode);
  // Mimic the real element's initial snapshot subscription without rendering.
  (f.app as unknown as { firstUpdated(): void }).firstUpdated();
  const pending = f.app.startFromProviderAction("built_in", mode);
  expect(f.selectDesktopAudio).not.toHaveBeenCalled();
  f.ready(); await pending;
  expect(f.selectDesktopAudio).toHaveBeenCalledWith(mode);
  expect(f.startRecording).not.toHaveBeenCalled();
});

it("revocation while preparation is pending discards the source choice", async () => {
  const f = fixture("preparing", "microphone");
  (f.app as unknown as { firstUpdated(): void }).firstUpdated();
  const pending = f.app.startFromProviderAction("built_in", "microphone");
  f.abort.abort(); f.ready(); await pending;
  expect(f.selectDesktopAudio).not.toHaveBeenCalled();
  expect(f.startRecording).not.toHaveBeenCalled();
});

it("an older desktop snapshot without metadata cannot turn consent into automatic start", async () => {
  const f = fixture("ready", "microphone", true);
  await f.app.startFromProviderAction("built_in");
  expect(f.startRecording).not.toHaveBeenCalled();
});
