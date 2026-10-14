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

function fixture(phase: "preparing" | "ready", audioMode: "microphone" | "meeting", missingDesktop = false, local = false) {
  let snapshot: ProviderRecorderSnapshot = {
    sessionId, state: phase, statusCode: phase === "ready" ? "capture_ready" : "capture_preparing",
    recordedChunks: 0, queuedChunks: 0, elapsedSeconds: 0,
    remainingBudgetSeconds: 900, remainingAuthoritySeconds: 900, transcript: null, transcriptionStatus: null,
    desktop: { phase, audioMode, coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null },
  };
  if (missingDesktop) delete (snapshot as { desktop?: ProviderRecorderSnapshot["desktop"] }).desktop;
  const listeners = new Set<(value: ProviderRecorderSnapshot) => void>();
  const startRecording = vi.fn(async () => undefined), deactivate = vi.fn(async () => undefined);
  const emit = (update: Partial<ProviderRecorderSnapshot>): void => {
    snapshot = { ...snapshot, ...update };
    for (const listener of listeners) listener(snapshot);
  };
  const selectDesktopAudio = vi.fn(async (value: "microphone" | "meeting") => { emit({ desktop: { ...snapshot.desktop!, audioMode: value } }); });
  const controller = {
    get snapshot() { return snapshot; }, subscribe(listener: (value: ProviderRecorderSnapshot) => void) {
      listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener); };
    }, startRecording, ...(!local ? { selectDesktopAudio } : {}),
  } as unknown as ProviderRecorderController;
  const abort = new AbortController(), app = new CaptureApp();
  Object.defineProperty(app, "isConnected", { configurable: true, value: false });
  vi.spyOn(app, "requestUpdate").mockImplementation(() => undefined);
  const binding = { sessionId, controller, signal: abort.signal, sourceKind: "microphone", ...(!local ? { captureMode: "desktop_meeting" } : {}), languageMode: "english", deactivate } as unknown as ProviderCaptureBinding;
  app.bindProvider(binding);
  Object.defineProperty(app, "isConnected", { configurable: true, value: true });
  Object.defineProperty(app, "querySelector", { configurable: true, value: () => null });
  cleanups.push(() => abort.abort());
  const ready = () => emit({ state: "ready", desktop: { ...snapshot.desktop!, phase: "ready" } });
  const subscribe = (): void => { (app as unknown as { firstUpdated(): void }).firstUpdated(); };
  return { app, abort, startRecording, selectDesktopAudio, ready, listeners, emit, subscribe,
    get snapshot() { return snapshot; },
    disconnect: () => Object.defineProperty(app, "isConnected", { configurable: true, value: false }) };
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

it.each(["ready", "preparing"] as const)("one explicit fresh microphone record action starts once after %s", async phase => {
  const f = fixture(phase, "microphone"); f.subscribe();
  const first = f.app.startFromProviderAction("built_in", "microphone", "microphone");
  const duplicate = f.app.startFromProviderAction("built_in", "microphone", "microphone");
  if (phase === "preparing") { expect(f.startRecording).not.toHaveBeenCalled(); f.ready(); }
  await Promise.all([first, duplicate]);
  await f.app.startFromProviderAction("built_in", "microphone", "microphone");
  expect(f.selectDesktopAudio).toHaveBeenCalledOnce(); expect(f.startRecording).toHaveBeenCalledOnce();
});

it.each(["ready", "preparing"] as const)("fresh microphone consent starts with reserved queue slots after %s", async phase => {
  const f = fixture(phase, "microphone"); f.subscribe();
  // The real configured flow reserves empty upload slots during preparation.
  // queuedChunks counts those reservations, before any source/audio exists.
  f.emit({ queuedChunks: 3 });
  const pending = f.app.startFromProviderAction("built_in", "microphone", "microphone");
  if (phase === "preparing") {
    expect(f.startRecording).not.toHaveBeenCalled(); f.ready();
  }
  await pending;
  expect(f.selectDesktopAudio).toHaveBeenCalledOnce();
  expect(f.startRecording).toHaveBeenCalledOnce();
  await f.app.startFromProviderAction("built_in", "microphone", "microphone");
  expect(f.startRecording).toHaveBeenCalledOnce();
});

it("readiness alone and a default source choice never record", async () => {
  const f = fixture("preparing", "microphone"); f.subscribe(); f.ready();
  expect(f.startRecording).not.toHaveBeenCalled();
  await f.app.startFromProviderAction("built_in", "microphone");
  expect(f.startRecording).not.toHaveBeenCalled();
});

it.each(["meeting-choice", "legacy", "missing-mode", "permission", "recorded", "elapsed", "coverage"])("discards the microphone record action for %s", async reason => {
  const f = fixture("ready", "microphone", reason === "legacy"); f.subscribe();
  if (reason === "missing-mode") {
    const desktop = { ...f.snapshot.desktop! }; delete desktop.audioMode;
    f.emit({ desktop }); f.selectDesktopAudio.mockImplementationOnce(async () => undefined);
  }
  if (reason === "permission") f.emit({ desktop: { ...f.snapshot.desktop!, phase: "permission_required" } });
  if (reason === "recorded") f.emit({ recordedChunks: 1 });
  if (reason === "elapsed") f.emit({ elapsedSeconds: 1 });
  if (reason === "coverage") f.emit({ desktop: { ...f.snapshot.desktop!, coverage: "complete" } });
  await f.app.startFromProviderAction("built_in", reason === "meeting-choice" ? "meeting" : "microphone", "microphone");
  expect(f.startRecording).not.toHaveBeenCalled();
});

it.each(["mismatch", "failure", "revocation", "unmount"])("does not replay after source selection %s", async reason => {
  const f = fixture("ready", "microphone"); f.subscribe();
  f.selectDesktopAudio.mockImplementationOnce(async () => {
    if (reason === "failure") throw new Error("Synthetic selection failure");
    if (reason === "mismatch") f.emit({ desktop: { ...f.snapshot.desktop!, audioMode: "meeting" } });
    if (reason === "revocation") f.abort.abort();
    if (reason === "unmount") f.disconnect();
  });
  const attempt = f.app.startFromProviderAction("built_in", "microphone", "microphone");
  if (reason === "failure") await expect(attempt).rejects.toThrow("Synthetic selection failure");
  else await attempt;
  f.ready(); await f.app.startFromProviderAction("built_in", "microphone", "microphone");
  expect(f.selectDesktopAudio).toHaveBeenCalledOnce(); expect(f.startRecording).not.toHaveBeenCalled();
});

it.each(["revocation", "unmount"])("discards the one-shot record action during delayed preparation after %s", async reason => {
  const f = fixture("preparing", "microphone"); f.subscribe();
  const attempt = f.app.startFromProviderAction("built_in", "microphone", "microphone");
  if (reason === "revocation") f.abort.abort(); else f.disconnect();
  f.ready(); await attempt;
  expect(f.selectDesktopAudio).not.toHaveBeenCalled(); expect(f.startRecording).not.toHaveBeenCalled();
});

it("rechecks the trusted microphone state immediately before controller Start", async () => {
  const f = fixture("ready", "microphone"); f.subscribe();
  f.selectDesktopAudio.mockImplementationOnce(async () => {
    // The source changed after selection completed, while the record operation
    // yielded before controller Start. No renderer argument can override it.
    queueMicrotask(() => queueMicrotask(() => f.emit({ desktop: { ...f.snapshot.desktop!, audioMode: "meeting" } })));
  });
  await f.app.startFromProviderAction("built_in", "microphone", "microphone");
  expect(f.startRecording).not.toHaveBeenCalled();
});

it("a controller Start failure leaves retries to the manual Start controls", async () => {
  const f = fixture("ready", "microphone"); f.subscribe();
  f.startRecording.mockRejectedValueOnce(new Error("Synthetic Start failure"));
  await f.app.startFromProviderAction("built_in", "microphone", "microphone");
  await f.app.startFromProviderAction("built_in", "microphone", "microphone");
  expect(f.startRecording).toHaveBeenCalledOnce();
});

it("an explicit canceled recording action leaves preparation authority intact and never replays", async () => {
  const f = fixture("preparing", "microphone"); f.subscribe();
  const action = new AbortController();
  const attempt = f.app.startFromProviderAction("built_in", "microphone", "microphone", action.signal);
  action.abort(); await attempt;
  expect(f.abort.signal.aborted).toBe(false);
  expect(f.selectDesktopAudio).not.toHaveBeenCalled(); expect(f.startRecording).not.toHaveBeenCalled();
  f.ready(); await f.app.startFromProviderAction("built_in", "microphone", "microphone", action.signal);
  expect(f.startRecording).not.toHaveBeenCalled();
});

it("cancellation during source selection prevents Start without revoking encounter access", async () => {
  const f = fixture("ready", "microphone"); f.subscribe();
  const action = new AbortController();
  f.selectDesktopAudio.mockImplementationOnce(async () => { action.abort(); });
  await f.app.startFromProviderAction("built_in", "microphone", "microphone", action.signal);
  expect(f.abort.signal.aborted).toBe(false); expect(f.startRecording).not.toHaveBeenCalled();
});

it("a non-desktop local recorder retains its existing consent-and-record continuation", async () => {
  const f = fixture("ready", "microphone", true, true); f.subscribe();
  await f.app.startFromProviderAction("built_in", undefined, undefined, new AbortController().signal);
  expect(f.startRecording).toHaveBeenCalledOnce(); expect(f.selectDesktopAudio).not.toHaveBeenCalled();
});
