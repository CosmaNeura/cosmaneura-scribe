import { afterEach, describe, expect, it, vi } from "vitest";
import { bindPreparationControls } from "./preparation-controls";
import type { AudioPreflightSnapshot, ProviderAudioPreflight } from "./audio-preflight";

// The control contract uses advisory metadata only. This tiny DOM adapter has
// no recorder, consent admission, audio, IPC or browser/network implementation.
class Control {
  hidden = false; disabled = false; checked = false; open = false;
  value = ""; textContent = ""; dataset: Record<string, string> = {};
  attributes = new Map<string, string>(); children: Control[] = [];
  constructor(readonly document: Controls, readonly selector = "") {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  closest() { return this; }
  replaceChildren(...children: Control[]) { this.children = children; }
  add(child: Control) { this.children.push(child); }
  focus() { this.document.focused = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
class Controls {
  nodes = new Map<string, Control>(); focused: Control | null = null;
  listeners = new Map<string, Set<(event: Event) => void>>();
  ownerDocument = { createElement: () => new Control(this) };
  constructor(isIOS: boolean, meeting = false) {
    for (const selector of ["[data-workspace-action=\"prepare\"]", "[name=\"consent\"]", "[data-consent-script]", "[data-audio-summary]",
      "[data-recording-guidance]", "[data-preflight-verdict]", "[data-preflight-access]", "[data-preflight-access-optional]",
      "[data-preflight-required-access]", "[data-preflight-access-help]", "[data-preflight-repair]", "[data-preflight-repair-steps]",
      "[data-preflight-details-help]", "[data-preflight-input]", "[data-audio-settings]", "[data-change-audio]", "[data-audio-done]",
      "[name=\"language\"]", "[name=\"modality\"]", "[name=\"desktop-audio\"]"]) this.node(selector);
    if (!isIOS) for (const selector of ["[data-preflight-meeting]", "[data-preflight-window]", "[data-preflight-call-heading]",
      "[data-preflight-call-title]", "[data-preflight-call-change]", "[data-preflight-call-picker]", "[data-preflight-call-done]",
      "[data-preflight-refresh]", "[data-preflight-window-help]"]) this.node(selector);
    this.node('[name="language"]').value = "en-US";
    this.node('[name="modality"]').value = meeting ? "virtual" : "in_person";
    this.node('[name="desktop-audio"]').value = meeting ? "meeting" : "microphone";
  }
  node(selector: string) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Control(this, selector)); return this.nodes.get(selector)!; }
  querySelector(selector: string) { return this.nodes.get(selector) ?? null; }
  querySelectorAll() { return []; }
  addEventListener(kind: string, listener: (event: Event) => void) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind)!.add(listener); }
  removeEventListener(kind: string, listener: (event: Event) => void) { this.listeners.get(kind)?.delete(listener); }
  emit(kind: string, selector: string) {
    const target = this.node(selector);
    const attribute = selector.slice(1, -1); if (!attribute.includes("=")) target.attributes.set(attribute, "");
    for (const listener of this.listeners.get(kind) ?? []) listener({ target } as unknown as Event);
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); });
function fixture(isIOS: boolean, initial: AudioPreflightSnapshot, openGate?: Promise<void>, onConsent?: () => void) {
  const root = new Controls(isIOS, initial.desktopAudio === "meeting");
  vi.stubGlobal("Element", Control);
  vi.stubGlobal("Option", class extends Control { constructor(label: string, value: string) { super(root); this.textContent = label; this.value = value; } });
  let current = initial;
  const listeners = new Set<(value: AudioPreflightSnapshot) => void>();
  const publish = (value: AudioPreflightSnapshot) => { current = value; for (const listener of listeners) listener(value); };
  const requestAccess = vi.fn(async () => publish({ ...current, status: "ready" }));
  const selectWindow = vi.fn(async (id: string) => publish({ ...current, meetingWindows: { ...current.meetingWindows!, selectedId: id } }));
  const closePort = vi.fn(async () => undefined);
  const port: ProviderAudioPreflight = {
    getSnapshot: () => current, subscribe: listener => { listeners.add(listener); listener(current); return () => listeners.delete(listener); },
    selectMicrophone: vi.fn(async () => undefined),
    selectDesktopAudio: vi.fn(async mode => publish({ ...current, desktopAudio: mode })),
    selectMeetingWindow: selectWindow,
    refreshMeetingWindows: vi.fn(async () => undefined), requestRecordingAccess: requestAccess,
    close: closePort,
  };
  const abort = new AbortController();
  const controls = bindPreparationControls(root as unknown as HTMLElement, { isIOS, signal: abort.signal,
    open: async () => { await openGate; return port; }, remember: vi.fn(), ...(onConsent ? { onConsent } : {}) });
  cleanups.push(() => controls.close());
  return { root, port, controls, publish, abort, requestAccess, selectWindow, closePort };
}
const readyIOS: AudioPreflightSnapshot = { status: "ready", inputDevices: [], selectedInputId: null, microphone: null };
const windows = Array.from({ length: 31 }, (_, index) => ({ id: `synthetic-window-${index}`, title: `Invented window ${index}` }));
const readyMac: AudioPreflightSnapshot = { status: "ready", inputDevices: [{ id: "synthetic-microphone", label: "Invented microphone", kind: "built_in", current: true }],
  selectedInputId: "synthetic-microphone", microphone: null, desktopAudio: "meeting", meetingWindows: { state: "ready", windows, selectedId: windows[0]!.id } };

describe("compact audio-free recording setup", () => {
  it("begins preparation only on a fresh checkbox action after metadata is ready", async () => {
    const consent = vi.fn(); const f = fixture(true, { ...readyIOS, status: "checking" }, undefined, consent);
    await vi.waitFor(() => expect(f.controls.snapshot()?.status).toBe("checking"));
    expect(f.root.node('[name="consent"]').disabled).toBe(true);
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    expect(consent).not.toHaveBeenCalled(); f.publish(readyIOS);
    expect(f.root.node('[name="consent"]').disabled).toBe(false); expect(consent).not.toHaveBeenCalled();
    f.root.node('[name="consent"]').checked = false; f.root.emit("change", '[name="consent"]');
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    f.root.emit("change", '[name="consent"]'); expect(consent).toHaveBeenCalledOnce();
    expect(f.requestAccess).not.toHaveBeenCalled();
  });
  it("permission checks and late readiness cannot replay a checked attestation", async () => {
    const consent = vi.fn(); const f = fixture(true, { ...readyIOS, status: "permission_required" }, undefined, consent);
    await vi.waitFor(() => expect(f.controls.snapshot()?.status).toBe("permission_required"));
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    f.root.emit("click", "[data-preflight-access]"); await vi.waitFor(() => expect(f.controls.ready()).toBe(true));
    expect(consent).not.toHaveBeenCalled(); await f.controls.close();
    f.root.node('[name="consent"]').checked = false; f.root.emit("change", '[name="consent"]');
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    expect(consent).not.toHaveBeenCalled();
  });
  it("puts ready diagnostics behind the optional action and leaves consent unchecked", async () => {
    const f = fixture(true, readyIOS);
    await vi.waitFor(() => expect(f.controls.ready()).toBe(true));
    expect(f.root.node("[data-preflight-required-access]").hidden).toBe(true);
    expect(f.root.node("[data-preflight-access-optional]").hidden).toBe(false);
    expect(f.root.node("[data-preflight-verdict]").textContent).toBe("Ready to start. Not listening yet.");
    expect(f.root.node("[data-audio-summary]").textContent).toContain("System microphone");
    expect(f.root.node('[name="consent"]').checked).toBe(false);
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    expect(f.requestAccess).not.toHaveBeenCalled();
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(false);
    expect(f.requestAccess).not.toHaveBeenCalled();
  });
  it("keeps required microphone access direct and grants no consent while checking it", async () => {
    const f = fixture(true, { ...readyIOS, status: "permission_required" });
    await vi.waitFor(() => expect(f.root.node("[data-preflight-required-access]").hidden).toBe(false));
    expect(f.controls.ready()).toBe(false);
    expect(f.root.node("[data-preflight-access-optional]").hidden).toBe(true);
    expect(f.root.node("[data-preflight-repair-steps]").children.map(child => child.textContent)).toEqual([
      "Open Settings on this iPhone.", "Allow Microphone access for Scribe.", "Return to Scribe, then choose Check recording access.",
    ]);
    expect(f.requestAccess).not.toHaveBeenCalled();
    f.root.emit("click", "[data-preflight-access]");
    await vi.waitFor(() => expect(f.root.node("[data-preflight-required-access]").hidden).toBe(true));
    expect(f.requestAccess).toHaveBeenCalledOnce();
    expect(f.root.node('[name="consent"]').checked).toBe(false);
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    await vi.waitFor(() => expect(f.root.focused === f.root.node('[name="consent"]')).toBe(true));
  });
  it("retains every manual window and keeps a selected call compact", async () => {
    const f = fixture(false, readyMac);
    await vi.waitFor(() => expect(f.controls.ready()).toBe(true));
    expect(f.root.node("[data-preflight-window]").children).toHaveLength(32);
    expect(f.root.node("[data-preflight-call-picker]").hidden).toBe(true);
    expect(f.root.node("[data-preflight-window-help]").hidden).toBe(true);
    expect(f.root.node("[data-recording-guidance]").textContent).toContain("Chrome may include other tabs");
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    f.root.emit("click", "[data-preflight-call-change]");
    expect(f.controls.ready()).toBe(false);
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    f.root.node("[data-preflight-window]").value = windows[30]!.id; f.root.emit("change", "[data-preflight-window]");
    await vi.waitFor(() => expect(f.controls.ready()).toBe(true));
    expect(f.selectWindow).toHaveBeenCalledWith(windows[30]!.id);
    expect(f.root.node("[data-preflight-call-picker]").hidden).toBe(true);
  });
  it("does not replace missing screen approval with microphone readiness", async () => {
    const f = fixture(false, { ...readyMac, meetingWindows: { ...readyMac.meetingWindows!, state: "permission_required", selectedId: null } });
    await vi.waitFor(() => expect(f.root.node("[data-preflight-verdict]").textContent).toBe("Screen Recording access is needed."));
    expect(f.controls.ready()).toBe(false);
    expect(f.root.node("[data-preflight-required-access]").hidden).toBe(false);
    expect(f.root.node("[data-preflight-repair-steps]").children.map(child => child.textContent)).toEqual([
      "Open System Settings → Privacy & Security → Screen Recording.", "Allow Scribe Desktop. If it is already on, turn it off and on.",
      "Reopen Scribe if macOS asks, then choose Check recording access.",
    ]);
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    expect(f.requestAccess).not.toHaveBeenCalled();
  });
  it("keeps Start disabled after a failed optional check until a successful recheck", async () => {
    const f = fixture(true, readyIOS);
    await vi.waitFor(() => expect(f.controls.ready()).toBe(true));
    f.root.node('[name="consent"]').checked = true; f.root.emit("change", '[name="consent"]');
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(false);
    f.requestAccess.mockRejectedValueOnce(new Error("Invented check failure"));
    f.root.emit("click", "[data-preflight-access-optional]");
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    await vi.waitFor(() => expect(f.root.node("[data-preflight-verdict]").textContent).toBe("Recording access check did not complete."));
    expect(f.root.node("[data-preflight-required-access]").hidden).toBe(false);
    expect(f.controls.snapshot()?.status).toBe("ready");
    expect(f.controls.ready()).toBe(false);
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    expect(f.root.node('[name="consent"]').checked).toBe(true);
    f.root.emit("change", '[name="consent"]');
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    // Foreground metadata recovery can report ready, but cannot acknowledge a
    // failed explicit access action. Only the current successful retry clears it.
    f.publish({ ...readyIOS, status: "checking" }); f.publish(readyIOS);
    expect(f.controls.ready()).toBe(false);
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    expect(f.root.node('[name="consent"]').checked).toBe(true);
    expect(f.requestAccess).toHaveBeenCalledOnce();
    f.root.emit("click", "[data-preflight-access]");
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    await vi.waitFor(() => expect(f.controls.ready()).toBe(true));
    expect(f.requestAccess).toHaveBeenCalledTimes(2);
    expect(f.root.node("[data-preflight-required-access]").hidden).toBe(true);
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(false);
    expect(f.root.node('[name="consent"]').checked).toBe(true);
  });
  it.each([true, false])("offers Back and reopen after initial access setup rejects (iOS: %s)", async isIOS => {
    const f = fixture(isIOS, isIOS ? readyIOS : { ...readyMac, desktopAudio: "microphone" },
      Promise.reject(new Error("Invented metadata setup failure")));
    await vi.waitFor(() => expect(f.root.node("[data-preflight-verdict]").textContent).toBe("Recording access could not be checked."));
    expect(f.controls.ready()).toBe(false);
    expect(f.root.node('[data-workspace-action="prepare"]').disabled).toBe(true);
    expect(f.root.node('[name="consent"]').checked).toBe(false);
    expect(f.root.node("[data-preflight-access]").hidden).toBe(true);
    expect(f.root.node("[data-preflight-access-optional]").hidden).toBe(true);
    expect(f.root.node("[data-preflight-access-help]").textContent).toBe("Choose Back, then reopen this visit to try again.");
    expect(f.root.node("[data-preflight-access-help]").textContent).not.toContain("Refresh");
    expect(f.requestAccess).not.toHaveBeenCalled();
  });
  it("joins a late metadata open on Close without reactivating controls", async () => {
    let release!: () => void;
    const f = fixture(true, readyIOS, new Promise<void>(resolve => { release = resolve; }));
    const close = f.controls.close();
    expect(f.controls.ready()).toBe(false); release(); await close;
    expect(f.closePort).toHaveBeenCalled();
    expect(f.requestAccess).not.toHaveBeenCalled();
    f.root.emit("click", "[data-preflight-access-optional]");
    expect(f.requestAccess).not.toHaveBeenCalled();
  });
});
