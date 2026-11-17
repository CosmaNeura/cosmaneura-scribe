import { webcrypto } from "node:crypto";
import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountProviderApplication, type ProviderApplicationHost } from "./application";
import {
  ACCOUNT_SELF_DELETE_MESSAGES,
  type AccountSelfDeleteClient,
  type AccountSelfDeleteHost,
} from "./account-self-delete";
import { Surface } from "./test-workspace-surface";
import type { ProviderCaptureBinding, ProviderRecorderSnapshot } from "../provider-binding";
import type { JournalSnapshot, ProviderProgress } from "./workspace-journal";
import type { bindPreparationControls } from "./preparation-controls";
import type { ProviderSessionState } from "./native-plugin";

/**
 * Submit-time recording guard: real workspace sets data-provider-recording-active;
 * application deleteAccount wrapper re-checks that flag (not a mocked workspace).
 */
vi.mock("../../public/icon.svg?raw", () => ({ default: "" }));
vi.mock("./application.css", () => ({}));
vi.mock("./account-self-delete-dialog.css", () => ({}));
vi.mock("../capture-app", () => ({}));

const metadata = vi.hoisted(() => ({
  options: null as Parameters<typeof bindPreparationControls>[1] | null,
  ready: true,
  close: vi.fn(async () => undefined),
}));
vi.mock("./preparation-controls", () => ({
  bindPreparationControls: (_root: HTMLElement, options: typeof metadata.options) => {
    metadata.options = options;
    return {
      ready: () => metadata.ready,
      snapshot: () => ({
        selectedInputId: "microphone-fixture",
        meetingWindows: { selectedId: "call-fixture" },
      }),
      close: () => metadata.close(),
    };
  },
}));

let capturedDialogHost: AccountSelfDeleteHost | null = null;
vi.mock("./account-self-delete-dialog", () => ({
  mountAccountSelfDeleteDialog: vi.fn((_parent: HTMLElement, host: AccountSelfDeleteHost) => {
    capturedDialogHost = host;
    return () => { capturedDialogHost = null; };
  }),
}));

class CommandSurface extends Surface {
  value = "";
  checked = false;
  override get innerHTML() { return super.innerHTML; }
  override set innerHTML(html: string) {
    super.innerHTML = html;
    for (const selector of [
      "[data-workspace-content]", "[data-workspace-notice]",
      "[data-workspace-progress]", "[data-workspace-navigation]",
    ]) {
      if (super.querySelector(selector)) this.nodes.set(selector, new CommandSurface());
    }
    for (const name of ["consent", "language", "modality", "microphone", "desktop-audio"]) {
      if (html.includes(`name="${name}"`)) {
        const node = new CommandSurface();
        node.value = ({
          language: "en-US", modality: "in_person", microphone: "built_in", "desktop-audio": "microphone",
        } as Record<string, string>)[name] ?? "";
        this.nodes.set(`[name="${name}"]`, node);
      }
    }
    if (html.includes("data-recording-preparation-status")) {
      this.nodes.set("[data-recording-preparation-status]", new CommandSurface());
    }
  }
  override querySelectorAll(selector: string): Surface[] {
    return selector.startsWith(".provider-preparation")
      ? [...this.nodes.values()]
      : super.querySelectorAll(selector);
  }
  override replaceChildren(...children: Surface[]): void {
    super.replaceChildren();
    if (children[0]) this.nodes.set("cosmaneura-capture", children[0]);
  }
}

class ApplicationSurface extends Surface {
  override set innerHTML(value: string) {
    super.innerHTML = value;
    for (const name of [
      "session-actions", "session-title", "session-message", "session-recovery", "provider-name",
    ]) {
      if (value.includes(`data-${name}`)) this.nodes.set(`[data-${name}]`, new ApplicationSurface());
    }
    if (value.includes("data-provider-workflow")) {
      this.nodes.set("[data-provider-workflow]", new CommandSurface());
    }
    if (value.includes('class="provider-session-header"')) {
      this.nodes.set(".provider-session-header", new ApplicationSurface());
    }
  }
  override closest(selector: string) {
    if (selector === "button[data-session-action]") return this;
    return super.closest(selector);
  }
}

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  capturedDialogHost = null;
  metadata.ready = true;
  metadata.close = vi.fn(async () => undefined);
  metadata.options = null;
});
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const sid = "00000000-0000-4000-8000-000000000001";
const suffix = "01j" + "0".repeat(23);
const ref = "appointment_" + suffix;

describe("account self-delete submit-time recording guard", () => {
  it("refuses Delete at submit when real workspace marks recording active after the dialog opened", async () => {
    vi.stubGlobal("Element", Surface);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("web");

    let snapshot: ProviderRecorderSnapshot = {
      sessionId: sid, state: "ready", statusCode: "capture_ready",
      recordedChunks: 0, queuedChunks: 3, elapsedSeconds: 0,
      remainingBudgetSeconds: 900, remainingAuthoritySeconds: 900,
      transcript: null, transcriptionStatus: null,
      selectedInputId: "other-fixture",
      inputDevices: [{ id: "microphone-fixture", label: "Invented microphone", kind: "built_in", current: true }],
      desktop: {
        phase: "ready", audioMode: "microphone", coverage: "not_started",
        trimmedStartMs: 0, trimmedEndMs: null,
        meetingWindows: { state: "ready", selectedId: null, windows: [{ id: "call-fixture", title: "Invented call" }] },
      },
    };
    const listeners = new Set<(s: ProviderRecorderSnapshot) => void>();
    const publish = (change: Partial<ProviderRecorderSnapshot>) => {
      snapshot = { ...snapshot, ...change };
      for (const fn of listeners) fn(snapshot);
    };
    const start = vi.fn(async () => undefined);
    const deactivate = vi.fn(async () => undefined);
    const controller = {
      get snapshot() { return snapshot; },
      subscribe(fn: (s: ProviderRecorderSnapshot) => void) {
        listeners.add(fn); fn(snapshot);
        return () => { listeners.delete(fn); };
      },
      startRecording: start,
      stopRecording: vi.fn(async () => undefined),
      refreshTranscriptionStatus: vi.fn(async () => undefined),
      selectAudioInput: vi.fn(async (id: string) => { publish({ selectedInputId: id }); }),
      selectDesktopAudio: vi.fn(async (audioMode: "microphone" | "meeting") => {
        publish({ desktop: { ...snapshot.desktop!, audioMode } });
      }),
      selectMeetingWindow: vi.fn(async (selectedId: string) => {
        publish({ desktop: { ...snapshot.desktop!, meetingWindows: { ...snapshot.desktop!.meetingWindows!, selectedId } } });
      }),
    };
    let binding: ProviderCaptureBinding | null = null;
    const app = Object.assign(new CommandSurface(), {
      bindProvider: vi.fn((b: ProviderCaptureBinding) => { binding = b; }),
      updateComplete: Promise.resolve(),
      startFromProviderAction: vi.fn(async () => { await start(); }),
    });
    const body = new ApplicationSurface();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible",
      body,
      createElement: () => app,
    });
    vi.stubGlobal("document", doc);

    let stored: JournalSnapshot = { revision: null, progress: null };
    const request = vi.fn(async (path: string, body: Record<string, unknown>, _key: string) => {
      const envelope = { ...body, contract_version: "1", checked_at: new Date().toISOString() };
      if (path.endsWith("capture-admissions")) {
        return Response.json({
          ...envelope, appointment_ref: ref, operation_ref: "scribe_admission_" + suffix,
          consent_record_id: sid, session_id: sid,
        });
      }
      return Response.json({
        ...envelope, operation: "creator_review",
        receipt: { schema_version: "1.0", session_id: sid, status: "created", source: null, working: null, review_queue: null },
      });
    });
    const journal = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (_previous: JournalSnapshot, progress: ProviderProgress) => {
        stored = { revision: String(Number(stored.revision ?? 0) + 1), progress: structuredClone(progress) };
        return stored;
      }),
    };
    const scope = {
      appointmentRef: ref,
      bindingRef: "scribe_capture_binding_" + suffix,
      workspaceId: sid,
    };
    const recorder = vi.fn(async () => ({
      controller, sourceKind: "microphone" as const, captureMode: "desktop_meeting" as const,
      deactivate, resumePendingWork: vi.fn(), releaseUploadedCapture: vi.fn(),
    }));
    const abort = new AbortController();
    const workspaceHost = {
      signal: abort.signal,
      recorderRechecksReview: true,
      consentPreparation: {
        enabled: true, owner: "John Clemente", cohort: "internal", expires: "2026-11-01",
      },
      listEncounters: vi.fn(async () => [
        { appointmentRef: ref, title: "Invented visit", detail: "Synthetic fixture" },
      ]),
      createEncounter: vi.fn(),
      openEncounter: vi.fn(async () => ({
        encounter: { appointmentRef: ref, title: "Invented visit", detail: "Synthetic fixture" },
        scope, request, signal: abort.signal, journal,
        openingReview: { scope, receivedAt: Date.now(), view: null },
        reviewJournal: () => ({ load: async () => null, save: vi.fn(), clear: vi.fn() }),
        recorder, openInCore: vi.fn(),
      })),
    };

    let state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    let observe!: (value: ProviderSessionState) => void;
    const deleteAccount = vi.fn(async () => ({
      outcome: "deleted" as const, status: "deleted" as const,
      practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    }));
    const accountSelfDelete: AccountSelfDeleteClient = { deleteAccount };
    const host: ProviderApplicationHost = {
      connect: vi.fn(async (signal: AbortSignal) => ({
        dispose: async () => undefined,
        workspace: { ...workspaceHost, signal },
      })),
      accountSelfDelete,
      session: {
        getState: async () => state,
        signIn: async () => { state = { phase: "ready", revision: crypto.randomUUID() }; observe(state); return state; },
        signOut: async () => { state = { phase: "signedOut", revision: crypto.randomUUID() }; observe(state); return state; },
        addListener: async (_name, listener) => { observe = listener; return { remove: async () => undefined }; },
      },
    };

    const root = new ApplicationSurface();
    cleanups.push(mountProviderApplication(root as unknown as HTMLElement, host));
    const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
    await settle();

    const workflow = root.querySelector("[data-provider-workflow]") as CommandSurface;
    expect(workflow).toBeTruthy();
    await vi.waitFor(() => expect(host.connect).toHaveBeenCalled());
    await settle();
    // Real workspace mounted — recording inactive before delete dialog.
    expect(workflow.innerHTML.length).toBeGreaterThan(0);
    expect(workflow.dataset.providerRecordingActive).toBeUndefined();

    const clickSession = async (action: string) => {
      const target = new ApplicationSurface();
      target.dataset.sessionAction = action;
      const event = new Event("click");
      Object.defineProperty(event, "target", { value: target });
      root.dispatchEvent(event);
      await settle();
    };
    await clickSession("delete-account");
    expect(capturedDialogHost).not.toBeNull();
    expect(deleteAccount).not.toHaveBeenCalled();

    // Drive the real workspace recording path so syncRecordingActive sets the flag.
    const content = workflow.querySelector("[data-workspace-content]")! as CommandSurface;
    expect(content).toBeTruthy();
    const clickWorkspace = (action: string) => {
      const button = content.querySelector(`[data-workspace-action="${action}"]`)
        ?? workflow.querySelector(`[data-workspace-action="${action}"]`)
        ?? new CommandSurface();
      button.dataset.workspaceAction = action;
      if (action === "open") button.dataset.appointment = ref;
      const event = new Event("click");
      Object.defineProperty(event, "target", { value: button });
      workflow.dispatchEvent(event);
    };
    await vi.waitFor(() => expect(workflow.attributes.has("aria-busy")).toBe(false));
    clickWorkspace("open");
    await vi.waitFor(() => expect(workspaceHost.openEncounter).toHaveBeenCalled(), { timeout: 2000 });
    await vi.waitFor(() => expect(workflow.attributes.has("aria-busy")).toBe(false));
    await vi.waitFor(() => {
      expect(content.innerHTML.includes('name="consent"') || content.innerHTML.includes("Confirm consent")).toBe(true);
    }, { timeout: 2000 });
    const checkbox = content.querySelector('[name="consent"]')! as CommandSurface;
    expect(checkbox).toBeTruthy();
    checkbox.checked = true;
    const change = new Event("change");
    Object.defineProperty(change, "target", { value: checkbox });
    content.dispatchEvent(change);
    workflow.dispatchEvent(change);
    if (content.innerHTML.includes("data-recording-preparation-status")) metadata.options?.onConsent?.();
    await vi.waitFor(() => expect(app.bindProvider).toHaveBeenCalledOnce());
    expect(workflow.dataset.providerRecordingActive).toBe("true");

    // Submit through the application wrapper captured when the dialog opened.
    const result = await capturedDialogHost!.client.deleteAccount({ confirm: "DELETE" });
    expect(result).toEqual({ outcome: "recording_active" });
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(ACCOUNT_SELF_DELETE_MESSAGES.recordingActive).toBe(
      "Stop the recording before deleting your account.",
    );
  });
});
