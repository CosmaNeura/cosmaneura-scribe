import { webcrypto } from "node:crypto";
import { Capacitor } from "@capacitor/core";
import { afterEach, expect, it, vi } from "vitest";
import { Surface } from "./test-workspace-surface";
import { mountProviderWorkspace, type ProviderWorkspaceHost } from "./workspace";
import type { ProviderCaptureBinding, ProviderRecorderSnapshot } from "../provider-binding";
import type { JournalSnapshot, ProviderProgress } from "./workspace-journal";
import type { bindPreparationControls } from "./preparation-controls";
import { CaptureDeviceCustodyError } from "../capture/device-custody";

// Run the actual workspace/admission/ownership flow. The tiny command surface
// and recorder contain no audio implementation; fictional parties consent.
vi.mock("../capture-app", () => ({}));
const metadata = vi.hoisted(() => ({ options: null as Parameters<typeof bindPreparationControls>[1] | null,
  ready: true, close: vi.fn(async () => undefined) }));
vi.mock("./preparation-controls", () => ({ bindPreparationControls: (_root: HTMLElement, options: typeof metadata.options) => {
  metadata.options = options;
  return { ready: () => metadata.ready, snapshot: () => ({ selectedInputId: "microphone-fixture",
    meetingWindows: { selectedId: "call-fixture" } }), close: () => metadata.close() };
} }));
class CommandSurface extends Surface {
  value = ""; checked = false;
  override get innerHTML() { return super.innerHTML; }
  override set innerHTML(html: string) {
    super.innerHTML = html;
    for (const selector of ["[data-workspace-content]", "[data-workspace-notice]", "[data-workspace-progress]", "[data-workspace-navigation]"]) {
      if (super.querySelector(selector)) this.nodes.set(selector, new CommandSurface());
    }
    for (const name of ["consent", "language", "modality", "microphone", "desktop-audio"]) {
      if (html.includes(`name="${name}"`)) {
        const node = new CommandSurface(); node.value = ({ language: "en-US", modality: "in_person", microphone: "built_in", "desktop-audio": "microphone" } as Record<string, string>)[name] ?? "";
        this.nodes.set(`[name="${name}"]`, node);
      }
    }
    if (html.includes("data-recording-preparation-status")) this.nodes.set("[data-recording-preparation-status]", new CommandSurface());
  }
  override querySelectorAll(selector: string): Surface[] {
    return selector.startsWith(".provider-preparation") ? [...this.nodes.values()] : super.querySelectorAll(selector);
  }
  override replaceChildren(...children: Surface[]): void { super.replaceChildren(); if (children[0]) this.nodes.set("cosmaneura-capture", children[0]); }
}
function gate<T>() { let resolve!: (v: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const sid = "00000000-0000-4000-8000-000000000001", suffix = "01j" + "0".repeat(23);
const ref = "appointment_" + suffix;
function fixture(options: { preparing?: boolean; admission?: Promise<void>; acquisition?: Promise<void>; release?: boolean; saved?: JournalSnapshot; metadataClose?: Promise<void>; journalSave?: Promise<void>;
  ios?: boolean; admissionFailure?: boolean; selection?: Promise<void>; signIn?: boolean; discover?: boolean } = {}) {
  vi.stubGlobal("Element", Surface); vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(options.ios === true);
  vi.spyOn(Capacitor, "getPlatform").mockReturnValue(options.ios ? "ios" : "web");
  metadata.ready = true; metadata.close = vi.fn(async () => { await options.metadataClose; });
  let stored: JournalSnapshot = options.saved ?? { revision: null, progress: null };
  let snapshot: ProviderRecorderSnapshot = { sessionId: sid, state: options.preparing ? "preparing" : "ready", statusCode: "capture_ready",
    recordedChunks: 0, queuedChunks: 3, elapsedSeconds: 0, remainingBudgetSeconds: 900, remainingAuthoritySeconds: 900, transcript: null, transcriptionStatus: null,
    selectedInputId: "other-fixture", inputDevices: [{ id: "microphone-fixture", label: "Invented microphone", kind: "built_in", current: true }],
    desktop: { phase: options.preparing ? "preparing" : "ready", audioMode: "microphone", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null,
      meetingWindows: { state: "ready", selectedId: null, windows: [{ id: "call-fixture", title: "Invented call" }] } } };
  const listeners = new Set<(s: ProviderRecorderSnapshot) => void>();
  const publish = (change: Partial<ProviderRecorderSnapshot>) => { snapshot = { ...snapshot, ...change }; for (const fn of listeners) fn(snapshot); };
  const start = vi.fn(async () => undefined), deactivate = vi.fn(async () => undefined);
  const controller = { get snapshot() { return snapshot; }, subscribe(fn: (s: ProviderRecorderSnapshot) => void) { listeners.add(fn); fn(snapshot); return () => { listeners.delete(fn); }; },
    startRecording: start, stopRecording: vi.fn(async () => undefined), refreshTranscriptionStatus: vi.fn(async () => undefined),
    selectAudioInput: vi.fn(async (id: string) => { await options.selection; publish({ selectedInputId: id }); }),
    selectDesktopAudio: vi.fn(async (audioMode: "microphone" | "meeting") => publish({ desktop: { ...snapshot.desktop!, audioMode } })),
    selectMeetingWindow: vi.fn(async (selectedId: string) => publish({ desktop: { ...snapshot.desktop!, meetingWindows: { ...snapshot.desktop!.meetingWindows!, selectedId } } })),
  };
  let binding: ProviderCaptureBinding | null = null;
  if (options.ios) delete (snapshot as { desktop?: ProviderRecorderSnapshot["desktop"] }).desktop;
  const app = Object.assign(new CommandSurface(), { bindProvider: vi.fn((b: ProviderCaptureBinding) => { binding = b; }), updateComplete: Promise.resolve(),
    startFromProviderAction: vi.fn(async (_input, _mode, intent, signal: AbortSignal) => { expect(signal.aborted).toBe(false); if (!options.ios) expect(intent).toBeDefined(); await start(); }) });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: () => app });
  vi.stubGlobal("document", doc);
  const root = new CommandSurface(), abort = new AbortController();
  let failAdmission = options.admissionFailure;
  const request = vi.fn(async (path: string, body: Record<string, unknown>, _key: string) => {
    expect(_key).toMatch(/^[A-Za-z0-9._:-]{8,255}$/u);
    const envelope = { ...body, contract_version: "1", checked_at: new Date().toISOString() };
    if (path.endsWith("capture-admissions")) {
      if (failAdmission) { failAdmission = false; throw new Error("Synthetic ambiguous admission"); }
      await options.admission;
      return Response.json({ ...envelope, appointment_ref: ref, operation_ref: "scribe_admission_" + suffix, consent_record_id: sid, session_id: sid });
    }
    if (options.discover && (body.operation as { kind?: string })?.kind === "provider_encounter")
      return Response.json({ ...envelope, operation: "provider_encounter", receipt: { schema_version: "1.0", status: "not_prepared", review: null } });
    return Response.json({ ...envelope, operation: "creator_review", receipt: { schema_version: "1.0", session_id: sid, status: "created", source: null, working: null, review_queue: null } });
  });
  const journal = { load: vi.fn(async () => stored), save: vi.fn(async (_previous: JournalSnapshot, progress: ProviderProgress) => {
    await options.journalSave;
    stored = { revision: String(Number(stored.revision ?? 0) + 1), progress: structuredClone(progress) }; return stored;
  }) };
  const signIn = { prepare: vi.fn<(signal: AbortSignal) => Promise<void>>(async () => undefined), abandon: vi.fn(async () => undefined) };
  const scope = { appointmentRef: ref, bindingRef: "scribe_capture_binding_" + suffix, workspaceId: sid };
  const recorder = vi.fn(async () => { await options.acquisition; return { controller, sourceKind: "microphone" as const, captureMode: options.ios ? "native_microphone" as const : "desktop_meeting" as const,
    deactivate, resumePendingWork: vi.fn(), releaseUploadedCapture: vi.fn() }; });
  const host: ProviderWorkspaceHost = { signal: abort.signal, recorderRechecksReview: true,
    ...(options.release === false ? {} : { consentPreparation: { enabled: true, owner: "John Clemente", cohort: "internal", expires: "2026-11-01" } }),
    listEncounters: vi.fn(async () => [{ appointmentRef: ref, title: "Invented visit", detail: "Synthetic fixture" }]), createEncounter: vi.fn(),
    openEncounter: vi.fn(async () => ({ encounter: { appointmentRef: ref, title: "Invented visit", detail: "Synthetic fixture" }, scope, request, signal: abort.signal, journal,
      ...(options.signIn ? { signInPreparation: signIn } : {}),
      ...(options.discover ? {} : { openingReview: { scope, receivedAt: Date.now(), view: null } }), reviewJournal: () => ({ load: async () => null, save: vi.fn(), clear: vi.fn() }), recorder, openInCore: vi.fn() })) };
  const dispose = mountProviderWorkspace(root as unknown as HTMLElement, host); disposers.push(dispose);
  const content = root.querySelector("[data-workspace-content]")! as CommandSurface;
  function click(action: string) {
    const button = content.querySelector(`[data-workspace-action="${action}"]`) ?? root.querySelector(`[data-workspace-action="${action}"]`) ?? new CommandSurface();
    button.dataset.workspaceAction = action; if (action === "open") button.dataset.appointment = ref;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); root.dispatchEvent(event);
  }
  const consent = (checked: boolean) => {
    const checkbox = content.querySelector('[name="consent"]')! as CommandSurface; checkbox.checked = checked;
    const event = new Event("change"); Object.defineProperty(event, "target", { value: checkbox });
    content.dispatchEvent(event); root.dispatchEvent(event);
    if (checked && content.innerHTML.includes("data-recording-preparation-status")) metadata.options?.onConsent?.();
  };
  const opened = async (waitForIdle = true) => { await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false)); click("open"); if (waitForIdle) await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false)); };
  return { root, content, request, journal, recorder, start, deactivate, controller, app, abort, dispose, click, consent, opened, doc, signIn,
    stored: () => stored, binding: () => binding, ready: () => publish(options.ios ? { state: "ready" } : { state: "ready", desktop: { ...snapshot.desktop!, phase: "ready" } }) };
}
it("checkbox alone prepares exactly once and never invokes any recording continuation", async () => {
  const f = fixture(); await f.opened(); expect(f.journal.save).not.toHaveBeenCalled();
  f.consent(true); await vi.waitFor(() => expect(f.app.bindProvider).toHaveBeenCalledOnce());
  expect(f.request.mock.calls.filter(([p]) => p.endsWith("capture-admissions"))).toHaveLength(1);
  expect(f.recorder).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled(); expect(f.app.startFromProviderAction).not.toHaveBeenCalled();
  expect(f.controller.selectAudioInput).toHaveBeenCalledWith("microphone-fixture");
  await f.binding()!.controller.startRecording(); expect(f.start).toHaveBeenCalledOnce();
});
it("an open screen stops checkbox preparation at expiry and retains explicit Start preparation", async () => {
  const expiry = Date.parse("2026-11-01T00:00:00Z");
  const now = vi.spyOn(Date, "now").mockReturnValue(expiry - 1);
  const f = fixture(); await f.opened(); expect(metadata.options?.onConsent).toBeDefined();
  now.mockReturnValue(expiry); f.consent(true);
  expect(f.journal.save).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.app.startFromProviderAction).not.toHaveBeenCalled();
  f.click("prepare"); // The explicit click evaluates the expired release control.
  now.mockRestore(); // Keep backend checked_at freshness on its unchanged clock.
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  expect(f.request.mock.calls.filter(([p]) => p.endsWith("capture-admissions"))).toHaveLength(1);
  expect(f.recorder).toHaveBeenCalledOnce(); expect(f.app.startFromProviderAction).toHaveBeenCalledOnce();
});
it("one immediate Record tap joins pending preparation; duplicate taps never start twice", async () => {
  const waiting = gate<void>(); const f = fixture({ preparing: true, admission: waiting.promise }); await f.opened();
  f.consent(true); f.click("prepare"); f.click("prepare"); expect(f.start).not.toHaveBeenCalled();
  waiting.resolve(); await vi.waitFor(() => expect(f.recorder).toHaveBeenCalledOnce()); expect(f.start).not.toHaveBeenCalled();
  f.ready(); await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce()); expect(f.app.startFromProviderAction).toHaveBeenCalledOnce();
});
it.each(["cancel", "withdraw", "back"])("%s discards queued Record and retains the original admission key", async action => {
  const waiting = gate<void>(); const f = fixture({ admission: waiting.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce()); const key = f.stored().progress!.admission!.key;
  if (action === "withdraw") f.consent(false); else f.click(action === "back" ? "encounters" : "cancel-recording-action");
  waiting.resolve(); await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  expect(f.start).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); expect(f.stored().progress!.admission!.key).toBe(key);
});
it("leave during late acquisition joins ownership and closes it without starting", async () => {
  const waiting = gate<void>(); const f = fixture({ acquisition: waiting.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.recorder).toHaveBeenCalledOnce()); let disposed = false; const close = f.dispose().then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false); waiting.resolve(); await close;
  expect(f.deactivate).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled();
});
it("withdrawal recovery requires a new checkbox and manual Record; no old intent/settings replay", async () => {
  const waiting = gate<void>(); const f = fixture({ admission: waiting.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce()); const original = structuredClone(f.stored().progress!.admission);
  f.consent(false); waiting.resolve(); await vi.waitFor(() => expect(f.content.innerHTML).toContain("Review prepared recording"));
  f.click("admit"); await vi.waitFor(() => expect(f.content.innerHTML).toContain("Confirm consent to continue"));
  expect((f.content.querySelector('[name="consent"]') as CommandSurface).checked).toBe(false);
  expect(f.start).not.toHaveBeenCalled(); f.consent(true); await vi.waitFor(() => expect(f.app.bindProvider).toHaveBeenCalledOnce());
  expect(f.stored().progress!.admission).toEqual(original); expect(f.app.startFromProviderAction).not.toHaveBeenCalled();
  await f.binding()!.controller.startRecording(); expect(f.start).toHaveBeenCalledOnce();
});
it("recovered virtual visits keep a microphone fallback without replaying or inferring source settings", async () => {
  const saved: JournalSnapshot = { revision: "1", progress: { admission: { key: "00000000-0000-4000-8000-000000000002", languageMode: "en-US",
    attestation: { modality: "virtual", participant_regions: [], method: "verbal_attestation", all_parties_consented: true,
      granted_at: new Date().toISOString() } }, sessionId: sid, uploaded: false, pendingSave: null } };
  const f = fixture({ saved }); await f.opened(false);
  await vi.waitFor(() => expect(f.content.innerHTML).toContain("Confirm consent to continue"));
  expect(f.content.innerHTML).toContain("Check the audio source on the next screen");
  f.consent(true); await vi.waitFor(() => expect(f.app.bindProvider).toHaveBeenCalledOnce());
  expect(f.controller.snapshot.desktop?.audioMode).toBe("microphone");
  expect(f.controller.selectDesktopAudio).not.toHaveBeenCalled(); expect(f.controller.selectAudioInput).not.toHaveBeenCalled();
  expect(f.controller.selectMeetingWindow).not.toHaveBeenCalled(); expect(f.app.startFromProviderAction).not.toHaveBeenCalled();
  expect(f.stored().progress?.admission).toEqual(saved.progress?.admission);
});
it("encrypted consent persistence overlaps metadata close; admission waits for both", async () => {
  const closing = gate<void>(); const f = fixture({ metadataClose: closing.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce());
  expect(metadata.close).toHaveBeenCalledOnce(); expect(f.stored().progress?.admission?.attestation.all_parties_consented).toBe(true);
  expect(f.request).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); closing.resolve();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
});
it("settled metadata cannot admit before the encrypted consent write finishes", async () => {
  const writing = gate<void>(); const f = fixture({ journalSave: writing.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce());
  expect(metadata.close).toHaveBeenCalledOnce(); expect(f.stored().progress).toBeNull();
  expect(f.request).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); writing.resolve();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
});
it("a metadata close failure still joins the consent write and never admits", async () => {
  const closing = gate<void>(), writing = gate<void>(); const f = fixture({ metadataClose: closing.promise, journalSave: writing.promise });
  await f.opened(); f.consent(true); f.click("prepare"); await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce());
  closing.reject(new Error("Synthetic metadata close failure")); await Promise.resolve();
  expect(f.root.attributes.has("aria-busy")).toBe(true); expect(f.request).not.toHaveBeenCalled(); writing.resolve();
  await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  expect(f.stored().progress?.admission?.key).toBeDefined(); expect(f.request).not.toHaveBeenCalled();
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  metadata.close = vi.fn(async () => undefined); // Explicit teardown can now finish the failed metadata owner.
});
it("a journal failure still joins metadata close and never admits", async () => {
  const closing = gate<void>(), writing = gate<void>(); const f = fixture({ metadataClose: closing.promise, journalSave: writing.promise });
  await f.opened(); f.consent(true); f.click("prepare"); await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce());
  writing.reject(new Error("Synthetic encrypted journal failure")); await Promise.resolve();
  expect(f.root.attributes.has("aria-busy")).toBe(true); expect(f.request).not.toHaveBeenCalled(); closing.resolve();
  await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  expect(f.stored().progress).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});
it("both failures retain the original metadata-close error classification", async () => {
  const closing = gate<void>(), writing = gate<void>(); const f = fixture({ metadataClose: closing.promise, journalSave: writing.promise });
  await f.opened(); f.consent(true); f.click("prepare"); await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce());
  writing.reject(new Error("Synthetic journal failure")); closing.reject(new CaptureDeviceCustodyError());
  await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  expect(f.content.innerHTML).toContain("Recording access needed on this device");
  expect(f.stored().progress).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  metadata.close = vi.fn(async () => undefined);
});
it("reopening an intent saved before metadata failure requires fresh consent and never replays Record", async () => {
  const closing = gate<void>(); const f = fixture({ metadataClose: closing.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce()); closing.reject(new Error("Synthetic metadata close failure"));
  await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  const saved = structuredClone(f.stored()), original = saved.progress!.admission;
  expect(f.request).not.toHaveBeenCalled(); metadata.close = vi.fn(async () => undefined); await f.dispose();
  const reopened = fixture({ saved }); await reopened.opened();
  expect(reopened.content.innerHTML).toContain("Recover recording preparation");
  expect(reopened.request).not.toHaveBeenCalled(); expect(reopened.recorder).not.toHaveBeenCalled();
  reopened.click("admit"); await vi.waitFor(() => expect(reopened.content.innerHTML).toContain("Confirm consent to continue"));
  const admissions = reopened.request.mock.calls.filter(([path]) => path.endsWith("capture-admissions"));
  expect(admissions).toHaveLength(1); expect(admissions[0]![2]).toBe(original!.key); expect(admissions[0]![1].attestation).toBeNull();
  expect((reopened.content.querySelector('[name="consent"]') as CommandSurface).checked).toBe(false);
  expect(reopened.app.startFromProviderAction).not.toHaveBeenCalled(); expect(reopened.start).not.toHaveBeenCalled();
  reopened.consent(true); await vi.waitFor(() => expect(reopened.app.bindProvider).toHaveBeenCalledOnce());
  expect(reopened.stored().progress!.admission).toEqual(original); expect(reopened.app.startFromProviderAction).not.toHaveBeenCalled();
  expect(reopened.controller.selectAudioInput).not.toHaveBeenCalled(); expect(reopened.start).not.toHaveBeenCalled();
});
it("disposal joins both in-flight operations before releasing the old encounter", async () => {
  const closing = gate<void>(), writing = gate<void>(); const f = fixture({ metadataClose: closing.promise, journalSave: writing.promise });
  await f.opened(); f.consent(true); f.click("prepare"); await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce());
  let disposed = false; const disposal = f.dispose().then(() => { disposed = true; });
  closing.resolve(); await Promise.resolve(); expect(disposed).toBe(false); writing.resolve(); await disposal;
  expect(f.stored().progress?.admission?.key).toBeDefined(); expect(f.journal.save).toHaveBeenCalledOnce();
  expect(f.request).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});
it.each(["withdraw", "background", "host-abort"])("%s during the join cannot revive a queued Record", async action => {
  const closing = gate<void>(), writing = gate<void>(); const f = fixture({ metadataClose: closing.promise, journalSave: writing.promise });
  await f.opened(); f.consent(true); f.click("prepare"); await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalledOnce());
  const key = f.journal.save.mock.calls[0]![1].admission!.key;
  if (action === "withdraw") f.consent(false);
  else if (action === "background") { f.doc.visibilityState = "hidden"; f.doc.dispatchEvent(new Event("visibilitychange")); }
  else f.abort.abort();
  closing.resolve(); writing.resolve(); await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  expect(f.stored().progress?.admission?.key).toBe(key); expect(f.request).not.toHaveBeenCalled();
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});
it("default-off hosts do no work on checkbox and preserve the explicit Start path", async () => {
  const f = fixture({ release: false }); await f.opened(); f.consent(true);
  expect(f.request).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); f.click("prepare");
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
});
it("iPhone checkbox does not start audio; an immediate explicit Record joins the same flight", async () => {
  const waiting = gate<void>(); const f = fixture({ ios: true, admission: waiting.promise }); await f.opened();
  f.consent(true); f.click("prepare"); expect(f.start).not.toHaveBeenCalled(); waiting.resolve();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce()); expect(f.app.startFromProviderAction).toHaveBeenCalledOnce();
});
it("ambiguous admission retains the same key; recovery requires fresh consent and never replays Start", async () => {
  const f = fixture({ admissionFailure: true }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  const original = structuredClone(f.stored().progress!.admission); expect(f.recorder).not.toHaveBeenCalled();
  f.click("admit"); await vi.waitFor(() => expect(f.content.innerHTML).toContain("Confirm consent to continue"));
  const admissions = f.request.mock.calls.filter(([path]) => path.endsWith("capture-admissions"));
  expect(admissions).toHaveLength(2); expect(admissions[0]![2]).toBe(admissions[1]![2]); expect(admissions[1]![1].attestation).toBeNull();
  expect(f.start).not.toHaveBeenCalled(); f.consent(true); await vi.waitFor(() => expect(f.app.bindProvider).toHaveBeenCalledOnce());
  expect(f.stored().progress!.admission).toEqual(original); expect(f.app.startFromProviderAction).not.toHaveBeenCalled();
});
it("withdrawal during delayed source configuration closes owned preparation without replay", async () => {
  const selecting = gate<void>(); const f = fixture({ selection: selecting.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.controller.selectAudioInput).toHaveBeenCalledOnce()); f.consent(false); selecting.resolve();
  await vi.waitFor(() => expect(f.deactivate).toHaveBeenCalledOnce()); expect(f.start).not.toHaveBeenCalled(); expect(f.app.bindProvider).not.toHaveBeenCalled();
});
it("foreground loss discards pending Record; returning does not start or restore consent intent", async () => {
  const waiting = gate<void>(); const f = fixture({ admission: waiting.promise }); await f.opened(); f.consent(true); f.click("prepare");
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce()); f.doc.visibilityState = "hidden"; f.doc.dispatchEvent(new Event("visibilitychange")); waiting.resolve();
  await vi.waitFor(() => expect(f.root.attributes.has("aria-busy")).toBe(false));
  f.doc.visibilityState = "visible"; f.doc.dispatchEvent(new Event("visibilitychange"));
  expect(f.start).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled();
});
it("foreground loss after confirmed Record does not terminate recording or its owner", async () => {
  const f = fixture(); await f.opened(); f.consent(true); f.click("prepare"); await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  f.doc.visibilityState = "hidden"; f.doc.dispatchEvent(new Event("visibilitychange"));
  expect(f.controller.stopRecording).not.toHaveBeenCalled(); expect(f.deactivate).not.toHaveBeenCalled();
});


it.each([false, true])("starts optional native sign-in only after empty discovery and current setup, platform iOS=%s", async ios => {
  const f = fixture({ ios, signIn: true, discover: true }); await f.opened();
  await vi.waitFor(() => expect(f.signIn.prepare).toHaveBeenCalledOnce());
  expect(f.request.mock.calls.map(([, body]) => (body.operation as { kind?: string })?.kind)).toEqual(["provider_encounter"]);
  expect(f.journal.save).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  expect((f.content.querySelector('[name="consent"]') as CommandSurface).checked).toBe(false);
  const first = f.signIn.prepare.mock.calls[0]![0];
  f.doc.visibilityState = "hidden"; f.doc.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(f.signIn.abandon).toHaveBeenCalled()); expect(first.aborted).toBe(true);
  f.doc.visibilityState = "visible"; f.doc.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(f.signIn.prepare).toHaveBeenCalledTimes(2));
  await f.dispose(); expect(f.recorder).not.toHaveBeenCalled();
});

it("joins fresh-consent auth preparation without waiting before the existing close+persist barrier", async () => {
  const closed = gate<void>(), saved = gate<void>(), auth = gate<void>();
  const f = fixture({ signIn: true, metadataClose: closed.promise, journalSave: saved.promise });
  f.signIn.prepare.mockImplementation(async () => auth.promise); await f.opened(); f.consent(true);
  await vi.waitFor(() => expect(metadata.close).toHaveBeenCalled()); expect(f.journal.save).toHaveBeenCalledOnce();
  expect(f.request).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  closed.resolve(); saved.resolve(); await vi.waitFor(() => expect(f.app.bindProvider).toHaveBeenCalledOnce());
  // A delayed optional acknowledgement did not insert an extra admission wait.
  expect(f.start).not.toHaveBeenCalled(); auth.resolve();
});

it("does not warm restored consent/recovery or a prepared recording", async () => {
  const saved: JournalSnapshot = { revision: "1", progress: { admission: { key: "synthetic-retained-key", languageMode: "en-US",
    attestation: { modality: "in_person", participant_regions: [], method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } },
    sessionId: null, uploaded: false, pendingSave: null } };
  const f = fixture({ signIn: true, saved }); await f.opened();
  expect(f.signIn.prepare).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
});
