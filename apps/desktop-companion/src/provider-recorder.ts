import { CaptureFlowController, type CaptureSessionKeyFactory } from "../../capture/src/flow/controller";
import type { CaptureFlowStore } from "../../capture/src/flow/types";
import type { CaptureStorageCapacity } from "../../capture/src/flow/storage-capacity";
import type { CreatorReviewView } from "../../review-ui/src/creator-review-api";
import { CaptureQueue } from "../../capture/src/queue/capture-queue";
import type { CaptureQueueStorage } from "../../capture/src/queue/types";
import { QueueInvariantError } from "../../capture/src/queue/errors";
import type { CaptureBff, CiphertextUploadTarget } from "../../capture/src/bff/contracts";
import { BffCaptureQueueTransport } from "../../capture/src/bff/queue-transport";
import type { ProviderRecorderController, ProviderRecorderSnapshot } from "../../capture/src/provider-binding";
import { DesktopCaptureController, type DesktopCaptureControllerOptions } from "./controller.js";
import { CAPTURE_OPERATION_TIMEOUT_MS } from "./config.js";
import type { AdapterSignal, DesktopCaptureAdapter } from "./capture-adapter.js";
import type { PersistentRecordingIndicator } from "./recording-indicator.js";
import { parseBackendCaptureGrant, type OneTimeCaptureCapability } from "./protocol.js";
import { DesktopPcmCaptureSource } from "./pcm-capture-source.js";
import type { DesktopPCMCoverage } from "./native-pcm-driver.js";
import type { NativeMeetingWindow } from "./native-provider-presentation.js";
import { NativeProcessPCMDriver, type AuthorizedDesktopSelection, type NativeProcessDriverOptions } from "./native-process-driver.js";
import type { NativeMicrophoneInputService } from "./native-microphone-inputs.js";
import { readMeetingWindows, recommendedCallWindow, sameCallWindow, type MeetingWindowChoice } from "./meeting-window-choice.js";

/** Saved server receipts, supplied to the backend for verification, not authority. */
export interface PreparedDesktopCapture {
  readonly sessionId: string;
  readonly captureLeaseId: string;
  readonly leaseReceiptId: string;
  readonly captureLeaseGeneration: number;
  readonly captureAuthorizedUntil: string;
  readonly firstSequenceNumber?: number;
}

export interface DesktopProviderRecorderOptions {
  readonly enabled?: boolean;
  readonly audioMode?: "microphone" | "meeting";
  readonly saveAudioMode?: (mode: "microphone" | "meeting") => Promise<void>;
  /** Selected by the trusted beta host; direct/diagnostic compositions default off. */
  readonly uploadWhileRecording?: boolean;
  /** Trusted app composition may expose disabled controls while metadata prepares. */
  readonly prepareInBackground?: boolean;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  /** Existing authenticated Core transport, bound to this cancellation signal. */
  readonly createBff: (signal: AbortSignal) => CaptureBff;
  /** Existing current Core creator/session read, before key binding or lease work. */
  readonly authorizePreparation: (signal: AbortSignal) => Promise<{
    readonly sessionId: string; readonly status: CreatorReviewView["status"];
  }>;
  /** After window choice, the backend verifies saved receipts against its current
   * state before issuing the desktop grant. Never derive one from the receipts. */
  readonly authorizeMount: (prepared: PreparedDesktopCapture, signal: AbortSignal) => Promise<{
    readonly grant: unknown; readonly status: "created" | "capturing";
  }>;
  readonly authority: NonNullable<DesktopCaptureControllerOptions["authority"]>;
  readonly indicator: PersistentRecordingIndicator;
  readonly flowStore: CaptureFlowStore;
  readonly storageCapacity: CaptureStorageCapacity;
  readonly createSessionKey: CaptureSessionKeyFactory;
  readonly queueStorage: CaptureQueueStorage;
  readonly uploadTarget: CiphertextUploadTarget;
  readonly coverage: { load(): Promise<DesktopPCMCoverage | null>; persist(value: DesktopPCMCoverage): Promise<void>;
    beginInterval?(receiptId: string, firstSequenceNumber: number): Promise<void>;
    hasPriorCapture?(receiptId: string): Promise<boolean>;
    capturedAudioFrames?(recordedChunks: number): Promise<number | null> };
  readonly native: Omit<NativeProcessDriverOptions, "enabled" | "authorizeSelectedWindow">;
  /** Native picker, deliberate choice only; never a renderer PID or first window. */
  readonly selectWindow: (signal: AbortSignal) => Promise<Omit<AuthorizedDesktopSelection, "captureAuthorizedUntil">>;
  readonly listMeetingWindows?: (signal: AbortSignal) => Promise<readonly NativeMeetingWindow[]>;
  /** Reuses only host-issued IDs for freshly revalidated native identities. */
  readonly meetingWindowChoices?: () => readonly MeetingWindowChoice[];
  readonly selectedMeetingWindowId?: () => string | null;
  readonly audioInputs?: NativeMicrophoneInputService;
  readonly autoReconnectMeeting?: true;
  /** Reveal only the current native chooser; never select or start another request. */
  readonly showWindowChooser?: () => Promise<void>;
  /** Retire backend ownership only after the physical native stop barrier. */
  readonly retireSource: () => Promise<void>;
  /** Close creator-scoped stores and release exclusive host ownership after stop. */
  readonly release: () => Promise<void>;
}

/** Trusted main composition. No identity, grant, storage key, helper path or
 * window selection can be supplied by its renderer view. Default disabled. */
export class DesktopProviderRecorder implements ProviderRecorderController {
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private flow: CaptureFlowController;
  private readonly createFlow: () => CaptureFlowController;
  private unsubscribeFlow: () => void;
  private readonly source: DesktopPcmCaptureSource;
  private controller: DesktopCaptureController;
  private readonly createController: () => DesktopCaptureController;
  private unsubscribeController: () => void;
  private readonly availability: (signal: AbortSignal) => Promise<"ready" | "permission_required">;
  private readonly requestPermissions: (signal: AbortSignal) => Promise<boolean>;
  private unmountedAvailability: "ready" | "permission_required" | null = null;
  private preparationResetPending = false;
  private initializing = true;
  private preparationFailed = false;
  private initialization: Promise<void> | null = null;
  private readonly listeners = new Set<(value: ProviderRecorderSnapshot) => void>();
  private readonly adapterListeners = new Set<(value: AdapterSignal) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private coverage: DesktopPCMCoverage | null = null;
  private continuityUnconfirmed = false;
  private unusedSetupKnown = false;
  private capability: OneTimeCaptureCapability | null = null;
  private attempt: AbortController | null = null;
  private initializationProbe: { readonly attempt: AbortController;
    readonly result: PromiseSettledResult<"ready" | "permission_required"> } | null = null;
  private selectedWindow: Omit<AuthorizedDesktopSelection, "captureAuthorizedUntil"> | null = null;
  private meetingWindows: MeetingWindowChoice[] = [];
  private meetingWindowId: string | null = null;
  private meetingWindowExplicit = false;
  private inheritedRecommendedIds = new Set<string>();
  private handoffCatalogRead = false;
  private meetingWindowsUnavailable = false;
  private choosingWindow = false;
  private startFailed = false;
  private callChoiceFailure: "capture_call_changed" | "capture_call_selection_required" | "capture_call_unavailable" | null = null;
  private operation: Promise<void> | null = null;
  private action: "prepare" | "start" | "resume" | "other" | null = null;
  private stopping: Promise<void> | null = null;
  private stopIntent: { upload: boolean } | null = null;
  private stoppingNative = false;
  private stopConfirmationPending = false;
  private reopenRequired = false;
  private halting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private deactivated = false;
  private closed = false;
  private captureMayBeActive = false;
  private capturePriorAudioFrames = 0;
  private capturedAudioFrames: number | null = null;
  private audioMode: "microphone" | "meeting";
  private inputLevels: Partial<Record<"microphone" | "meetingAudio", { level: number; receivedAt: number }>> = {};
  private lastSelectedWindow: NativeMeetingWindow | null = null;
  private lastSelectedWindowExplicit = false;
  private callReconnectRequested = false;
  private reconnecting = false;
  private reconnectGeneration = 0;
  private continuationGeneration = 0;
  private switchingInput = false;
  private inputSwitch: Promise<void> | null = null;

  private constructor(private readonly options: DesktopProviderRecorderOptions) {
    if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
      || "type" in process && process.type === "renderer" || options.enabled !== true
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.sessionId) || options.signal.aborted) throw unavailable();
    this.audioMode = options.audioMode ?? "meeting";
    this.signal = AbortSignal.any([options.signal, this.abort.signal]);
    const driver = new NativeProcessPCMDriver({ ...options.native, enabled: true, audioMode: () => this.audioMode,
      ...(options.audioInputs ? { microphoneUID: () => options.audioInputs!.selectedUID } : {}),
      authorizeSelectedWindow: async () => {
        this.requireStart();
        const selection = this.selectedWindow;
        this.selectedWindow = null;
        if (selection === null) throw unavailable();
        this.requireStart();
        const active = await options.flowStore.getActiveCaptureState();
        this.requireStart();
        if (active?.sessionId !== options.sessionId || active.phase !== "recording" || active.channel !== "mixed"
          || active.captureAuthorizedUntil === null) throw unavailable();
        return { ...selection, captureAuthorizedUntil: Date.parse(active.captureAuthorizedUntil) };
      } });
    this.source = new DesktopPcmCaptureSource(driver, async value => {
      await options.coverage.persist(value); this.coverage = structuredClone(value); this.publish();
    }, value => {
      if (value === null) this.inputLevels = {};
      else this.inputLevels[value.channel] = { level: value.level, receivedAt: performance.now() };
      this.publish();
    }, frames => {
      const previous = Math.floor((this.capturedAudioFrames ?? 0) / 16_000);
      this.capturedAudioFrames = this.capturePriorAudioFrames + frames;
      if (Math.floor(this.capturedAudioFrames / 16_000) !== previous) this.publish();
    }, code => {
      this.callReconnectRequested = code === "meeting_disconnected" && options.autoReconnectMeeting === true
        && this.audioMode === "meeting" && this.lastSelectedWindow !== null;
    }, options.native.diagnostics);
    const bff = options.createBff(this.signal);
    this.createFlow = () => new CaptureFlowController({ bff, flowStore: options.flowStore, createSessionKey: options.createSessionKey,
      initialReservationCount: 30,
      source: this.source, storageCapacity: options.storageCapacity, queue: new CaptureQueue(options.queueStorage),
      uploadWhileRecording: options.uploadWhileRecording === true,
      pauseForStorage: () => this.pauseRecording(),
      queueTransport: new BffCaptureQueueTransport(bff, options.uploadTarget) });
    this.flow = this.createFlow();
    const availability = async (signal: AbortSignal): Promise<"ready" | "permission_required"> => {
      this.requireOpen(); if (signal.aborted) throw unavailable();
      const available = await driver.getAvailability();
      this.requireOpen(); if (signal.aborted) throw unavailable();
      return available ? "ready" : "permission_required";
    };
    this.availability = availability;
    this.requestPermissions = signal => driver.requestPermissions(signal);
    const adapter: DesktopCaptureAdapter = {
      initialize: signal => {
        const probe = this.initializationProbe; this.initializationProbe = null;
        this.requireOpen();
        if (!probe || probe.attempt !== this.attempt || probe.attempt.signal.aborted || signal.aborted) throw unavailable();
        if (probe.result.status === "rejected") throw probe.result.reason;
        return Promise.resolve(probe.result.value);
      },
      refreshPermissions: availability,
      start: async (capability, signal) => {
        this.requireOpen(); if (!this.attempt || this.attempt.signal.aborted || signal.aborted) throw unavailable();
        this.capability = capability; this.captureMayBeActive = true;
        const cancel = (): void => { this.attempt?.abort(); void this.halt().catch(() => undefined); };
        signal.addEventListener("abort", cancel, { once: true });
        this.attempt.signal.addEventListener("abort", cancel, { once: true });
        try {
          await this.flow.startRecording(); this.requireStart();
          if (this.flow.snapshot.state !== "recording") throw unavailable();
        } finally {
          signal.removeEventListener("abort", cancel); this.attempt?.signal.removeEventListener("abort", cancel);
          this.capability = null;
        }
      },
      stop: async () => { await this.source.stop(); this.captureMayBeActive = false; },
      abort: () => this.halt(), shutdown: () => this.halt(),
      onSignal: listener => { this.adapterListeners.add(listener); return () => this.adapterListeners.delete(listener); },
    };
    this.createController = () => new DesktopCaptureController(adapter, options.indicator, { enabled: true,
      authority: { authorizeStart: async (grant, signal) => {
        this.requireOpen();
        if (!this.attempt) throw unavailable();
        const linked = AbortSignal.any([signal, this.signal, this.attempt.signal]);
        if (linked.aborted) throw unavailable();
        const decision = await options.authority.authorizeStart(grant, linked);
        if (linked.aborted) throw unavailable();
        return decision;
      } } });
    this.controller = this.createController();
    this.unsubscribeController = this.controller.subscribe(() => this.publish());
    this.unsubscribeFlow = this.subscribeFlow();
    this.unsubscribe.push(() => this.unsubscribeController(), () => this.unsubscribeFlow());
    if (options.audioInputs) this.unsubscribe.push(options.audioInputs.subscribe(() => this.publish()));
    options.signal.addEventListener("abort", this.onRevocation, { once: true });
  }

  static async open(options: DesktopProviderRecorderOptions): Promise<DesktopProviderRecorder> {
    options = Object.freeze({ ...options, native: Object.freeze({ ...options.native }) });
    const recorder = new DesktopProviderRecorder(options);
    recorder.initialization = recorder.initialize().catch(async error => {
      recorder.preparationFailed = true;
      // No source has started. Stop timers and retain exact encrypted recovery
      // state under this owner until navigation/deactivation releases custody.
      await recorder.halt(); throw error;
    }).finally(() => { recorder.initializing = false; recorder.publish(); });
    if (options.prepareInBackground === true) {
      // Main retains this owner before its renderer attaches. Every recording
      // command remains unavailable until the same fresh preparation finishes.
      void recorder.initialization.catch(() => undefined);
      return recorder;
    }
    try { await recorder.initialization; return recorder; }
    catch (error) { await recorder.deactivate(); throw error; }
  }
  private initialize(): Promise<void> {
    const options = this.options;
    return this.run("prepare", async () => {
      const current = Object.freeze({ ...await options.authorizePreparation(this.signal) }); this.requireOpen();
      if (current.sessionId !== options.sessionId || ![
        "created", "capturing", "uploaded", "processing", "speech_failed", "speech_retryable",
        "handed_off", "translation_pending", "review_required", "transcript_ready", "quality_blocked",
      ].includes(current.status)) throw unavailable();
      const reads = await Promise.allSettled([options.flowStore.getActiveCaptureState(), options.flowStore.getPreparationState()]);
      if (reads[0].status === "rejected") throw reads[0].reason;
      if (reads[1].status === "rejected") throw reads[1].reason;
      const [active, preparing] = [reads[0].value, reads[1].value];
      this.requireOpen();
      // A failed start can retain a prepared continuation while earlier chunks
      // have already advanced the server to capturing. Restore that exact
      // durable attempt; fresh setup and finalized work remain excluded.
      const mayRestoreReady = current.status === "created" || current.status === "capturing"
        && active?.phase === "ready" && active.continuation?.prepared === true
        && active.continuation.continuous !== true;
      if (active && (active.sessionId !== options.sessionId || active.reviewAfterUpload !== true || active.channel !== "mixed")
        || preparing && (preparing.sessionId !== options.sessionId || preparing.mode !== "configured_core" || preparing.channel !== "mixed")
        || current.status !== "created" && active === null && preparing === null
        || !mayRestoreReady && active?.phase === "ready") throw unavailable();
      this.coverage = await options.coverage.load(); this.requireOpen();
      // An already-paused owner with missing history is not proof of unused
      // setup. Only new/ready setup can make its first call choice on expiry.
      this.unusedSetupKnown = (active === null || active.phase === "ready") && this.coverage === null;
      this.continuityUnconfirmed = active?.continuation !== undefined;
      const prepare = async (): Promise<void> => {
        if (!await this.flow.restore()) await this.flow.prepareConfigured(options.sessionId);
      };
      let initialAvailability: "ready" | "permission_required" | undefined;
      let discoveredMeetingWindows = false;
      if (current.status === "created" && active === null && this.coverage === null) {
        // This read-only probe cannot capture or prompt. Overlap it with fresh
        // secure setup only after the trusted creator/session preflight. Wait
        // for both branches, including on failure, before releasing ownership.
        // The separate fresh check after window choice still runs at Start.
        // Window metadata is another independent read after creator/session and
        // retained-owner checks. Overlap its bounded OS discovery with secure
        // preparation, rather than adding that lookup to the end of startup.
        // Selection and Start remain blocked until every branch has settled.
        discoveredMeetingWindows = !!options.listMeetingWindows && this.audioMode === "meeting";
        const [preparation, availability, windows] = await Promise.allSettled([
          prepare(), this.availability(this.signal),
          discoveredMeetingWindows ? this.loadMeetingWindows() : Promise.resolve(),
        ]);
        if (preparation.status === "rejected") throw preparation.reason;
        if (availability.status === "rejected") throw availability.reason;
        if (windows.status === "rejected") throw windows.reason;
        initialAvailability = availability.value;
      } else await prepare();
      this.requireOpen();
      if (this.flow.snapshot.sessionId !== options.sessionId) throw unavailable();
      if (active) {
        this.capturedAudioFrames = await options.coverage.capturedAudioFrames?.(this.flow.snapshot.recordedChunks) ?? null;
        this.requireOpen();
      }
      if (this.flow.snapshot.state === "ready") {
        if (active?.continuation) {
          if (!options.coverage.beginInterval) throw unavailable();
          await options.coverage.beginInterval(active.lease.receipt_id, active.continuation.firstSequenceNumber);
          this.coverage = await options.coverage.load(); this.requireOpen();
        }
        if (this.coverage !== null) throw unavailable(); // Never replay an attempt over retained coverage.
        if (!mayRestoreReady) throw unavailable();
        await this.preparedContext();
        // Surface the existing storage guard before a person chooses a source.
        // Keep the ready owner so freeing space permits the normal fresh Start
        // check; a low/unknown capacity never grants capture or changes reserve.
        try { await this.flow.checkStorageCapacity(); }
        catch (error) {
          if (!(error instanceof QueueInvariantError)
            || !["capture_storage_low", "capture_storage_unavailable"].includes(error.code)) throw error;
        }
        this.requireOpen();
        this.unmountedAvailability = initialAvailability ?? await this.availability(this.signal);
      }
      if (active?.continuation) {
        this.continuityUnconfirmed = active.continuation.firstSequenceNumber > 0
          || await options.coverage.hasPriorCapture?.(active.lease.receipt_id) !== false;
        this.requireOpen();
      }
      if (!discoveredMeetingWindows && options.listMeetingWindows && this.audioMode === "meeting"
        && ["ready", "paused", "error"].includes(this.flow.snapshot.state)) await this.loadMeetingWindows();
    });
  }

  get snapshot(): ProviderRecorderSnapshot {
    const flow = this.flow.snapshot, control = this.controller.snapshot();
    const phase = this.stoppingNative || this.closing && !this.closed ? "stopping"
      : this.preparationFailed ? "stopped" : this.initializing ? "preparing"
      : this.captureMayBeActive && control.state === "failed" ? "stop_unconfirmed"
      : this.stopping && (this.stopConfirmationPending || flow.state === "paused") ? "stopping"
      : this.stopping && !this.captureMayBeActive ? "stopped"
      : this.reopenRequired && flow.state === "error" ? "stopped"
      : this.action === "start" || this.action === "resume" ? "starting" : control.state === "recording" && flow.state === "recording" ? "recording"
      : control.state === "permission_required" || this.unmountedAvailability === "permission_required" ? "permission_required"
      : flow.state === "ready" && (control.state === "ready" || this.unmountedAvailability === "ready") ? "ready"
      : ["paused", "error", "ready", "recording"].includes(flow.state) && !this.closed ? "interrupted" : "stopped";
    const start = this.coverage?.phase === "started" ? this.coverage.value : this.coverage?.value.start;
    const setupExpired = phase === "interrupted" && flow.statusCode === "capture_authority_expired"
      && !this.captureMayBeActive && !this.continuityUnconfirmed && this.coverage === null && flow.recordedChunks === 0;
    return { ...flow, state: this.preparationFailed ? "error" : this.initializing ? "preparing" : flow.state,
      statusCode: this.preparationFailed ? "capture_preparation_failed" : this.initializing ? "capture_preparing"
      : this.stopConfirmationPending ? "capture_stop_acknowledgement_pending"
      : this.stopping && phase === "stopped" && flow.state === "recording" ? "capture_upload_settling"
      : this.reopenRequired && flow.state === "error" ? "capture_reopen_required"
      : setupExpired ? "capture_setup_expired"
      : !this.captureMayBeActive && ["ready", "interrupted"].includes(phase) && this.callChoiceFailure !== null ? this.callChoiceFailure
      : phase === "ready" && this.startFailed && !["capture_storage_low", "capture_storage_unavailable"].includes(flow.statusCode) ? "capture_start_failed"
      : this.choosingWindow ? "capture_window_selection_pending" : flow.statusCode,
      sessionId: this.options.sessionId, transcript: null, transcriptionStatus: null,
      ...(this.options.audioInputs ? { inputDevices: this.options.audioInputs.getSnapshot().inputDevices,
        selectedInputId: this.options.audioInputs.getSnapshot().selectedInputId } : {}),
      ...(this.options.autoReconnectMeeting ? { reconnecting: this.reconnecting } : {}),
      elapsedSeconds: this.capturedAudioFrames === null ? flow.elapsedSeconds : Math.floor(this.capturedAudioFrames / 16_000),
      desktop: { phase, audioMode: this.audioMode,
      ...(this.options.listMeetingWindows ? { meetingWindows: { state: this.meetingWindowsUnavailable ? "unavailable" as const : "ready" as const,
        selectedId: this.meetingWindowId, windows: this.meetingWindows.map(row => ({ id: row.id, title: row.value.title })) } } : {}),
      inputSignal: { microphone: this.inputLevel("microphone", phase),
        meetingAudio: this.inputLevel("meetingAudio", phase) }, coverage: this.continuityUnconfirmed ? "incomplete" : this.coverage?.phase === "stopped" ? "complete"
        : this.coverage ? phase === "recording" ? "aligned" : "incomplete" : "not_started",
      trimmedStartMs: start ? milliseconds(start.microphonePrerollNanoseconds, start.systemPrerollNanoseconds) : 0,
      trimmedEndMs: this.coverage?.phase === "stopped"
        ? milliseconds(this.coverage.value.microphoneTailNanoseconds, this.coverage.value.systemTailNanoseconds) : null } };
  }
  private inputLevel(channel: "microphone" | "meetingAudio", phase: string): { level: number; ageMs: number } | null {
    const value = this.inputLevels[channel];
    if (phase !== "recording" || !value) return null;
    return { level: value.level, ageMs: Math.max(0, Math.floor(performance.now() - value.receivedAt)) };
  }
  get availableForView(): boolean { return !this.deactivated && !this.signal.aborted; }
  subscribe(listener: (value: ProviderRecorderSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener);
  }
  async selectDesktopAudio(mode: "microphone" | "meeting"): Promise<void> {
    this.requireOpen();
    if (!["microphone", "meeting"].includes(mode) || this.initializing || this.operation || this.stopping || this.switchingInput || this.reconnecting
      || this.captureMayBeActive || this.coverage !== null || this.flow.snapshot.recordedChunks > 0) throw unavailable();
    if (mode === this.audioMode) return;
    await this.run("other", async () => {
      await this.options.saveAudioMode?.(mode); this.requireOpen();
      this.audioMode = mode;
      this.callChoiceFailure = null;
      this.unmountedAvailability = await this.availability(this.signal); this.requireOpen();
    });
    if (mode === "meeting" && this.options.listMeetingWindows) await this.refreshMeetingWindows();
  }
  async selectAudioInput(id: string): Promise<void> {
    this.requireOpen();
    const inputs = this.options.audioInputs;
    if (!inputs || !inputs.getSnapshot().inputDevices.some(input => input.id === id)
      || this.initializing || this.operation || this.stopping || this.reconnecting || this.switchingInput) throw unavailable();
    if (id === inputs.getSnapshot().selectedInputId) return;
    const recording = this.flow.snapshot.state === "recording";
    if (!recording && !["ready", "paused"].includes(this.flow.snapshot.state)) throw unavailable();
    // Hardware replacement starts a new disclosed interval. Drain the current
    // source and retire its lease before changing the native input or authority.
    this.switchingInput = true;
    const generation = this.continuationGeneration;
    const work = (async () => {
      // This internal drain preserves the choice's ticket. A deliberate Pause
      // or Finish cancels that ticket and joins the pending hardware save.
      if (recording) await this.stopCapture(false, false);
      this.requireContinuation(generation);
      if (recording && this.flow.snapshot.state !== "paused") throw unavailable();
      await inputs.selectMicrophone(id); this.requireContinuation(generation);
      if (recording) await this.resumeCapture(generation);
    })().finally(() => { this.inputSwitch = null; this.switchingInput = false; this.publish(); });
    this.inputSwitch = work;
    return work;
  }
  refreshMeetingWindows(): Promise<void> {
    this.requireOpen();
    if (!this.options.listMeetingWindows || this.audioMode !== "meeting" || this.captureMayBeActive || this.stopping
      || !["ready", "permission_required", "interrupted", "stopped"].includes(this.snapshot.desktop!.phase)) throw unavailable();
    return this.run("other", async () => {
      await this.loadMeetingWindows();
      if (!this.meetingWindowsUnavailable && this.callChoiceFailure === "capture_call_unavailable") {
        this.callChoiceFailure = null; this.startFailed = false; this.publish();
      }
    });
  }
  private async loadMeetingWindows(signal = this.signal): Promise<void> {
    const host = this.options.meetingWindowChoices?.() ?? [];
    const preferred = this.meetingWindowId ?? (!this.handoffCatalogRead ? this.options.selectedMeetingWindowId?.() ?? null : null);
    const explicit = this.meetingWindowExplicit || !this.handoffCatalogRead && preferred !== null
      && host.find(row => row.id === preferred)?.selection !== "recommended";
    const previous = [...this.meetingWindows, ...host];
    if (!this.handoffCatalogRead) {
      this.inheritedRecommendedIds = new Set(host.filter(row => row.selection === "recommended").map(row => row.id));
      this.handoffCatalogRead = true;
    }
    this.meetingWindowId = null; this.meetingWindows = []; this.meetingWindowsUnavailable = false; this.publish();
    try {
      const rows = await readMeetingWindows(this.options.listMeetingWindows!, signal); this.requireOpen();
      if (signal.aborted) throw unavailable();
      this.meetingWindows = rows.map(value => ({ id: previous.find(row => sameCallWindow(row.value, value))?.id ?? crypto.randomUUID(), value }));
      this.meetingWindowExplicit = explicit && this.meetingWindows.some(row => row.id === preferred);
      this.meetingWindowId = this.meetingWindowExplicit ? preferred : recommendedCallWindow(this.meetingWindows)?.id ?? null;
    } catch { this.requireOpen(); this.meetingWindowExplicit = false; this.meetingWindowsUnavailable = true;
      if (signal.aborted) throw unavailable();
    } finally { this.publish(); }
  }
  selectMeetingWindow(id: string): Promise<void> {
    try {
      this.requireOpen();
      if (!this.options.listMeetingWindows || this.audioMode !== "meeting" || this.initializing || this.operation || this.captureMayBeActive || this.stopping
        || !this.meetingWindows.some(row => row.id === id)) throw unavailable();
      this.meetingWindowId = id;
      // Preparation's first opaque-ID handoff retains its automatic provenance.
      // A later provider choice is explicit, including choosing among two calls.
      this.meetingWindowExplicit = !this.inheritedRecommendedIds.delete(id);
      if (this.callChoiceFailure !== null) this.startFailed = false;
      this.callChoiceFailure = null;
      this.publish(); return Promise.resolve();
    } catch { return Promise.reject(unavailable()); }
  }
  startRecording(): Promise<void> {
    this.requireOpen();
    if (this.snapshot.desktop?.phase !== "ready" || this.operation || this.stopping || this.switchingInput || this.reconnecting) return Promise.reject(unavailable());
    const generation = this.continuationGeneration;
    this.startFailed = false;
    this.callChoiceFailure = null;
    this.attempt = new AbortController();
    const attempt = this.attempt;
    return this.run("start", () => this.startAttempt(attempt, generation));
  }
  private async startAttempt(attempt: AbortController, generation: number): Promise<void> {
    // Human window choice precedes the fresh server decision and the native
    // helper's bounded startup. No grant or active indicator is spent waiting
    // for a person to choose. The native source still revalidates the window.
    try {
      this.requireAttempt(attempt, generation);
      await this.flow.checkStorageCapacity(); this.requireAttempt(attempt, generation);
      this.choosingWindow = this.audioMode === "meeting" && !this.options.listMeetingWindows; this.publish();
      let selected: Awaited<ReturnType<DesktopProviderRecorderOptions["selectWindow"]>>;
      try { selected = this.audioMode === "microphone" ? { application: "microphone", processID: 0, windowID: 0 }
        : this.options.listMeetingWindows ? await this.checkedInlineWindow(attempt, generation)
        : await chooseWindow(this.options.selectWindow, attempt.signal); }
      finally { this.choosingWindow = false; this.publish(); }
      this.requireAttempt(attempt, generation);
      this.selectedWindow = Object.freeze({ application: selected.application,
        processID: selected.processID, windowID: selected.windowID });
      this.lastSelectedWindow = selected.application === "microphone" ? null
        : Object.freeze({ application: selected.application, processID: selected.processID, windowID: selected.windowID,
          title: "title" in selected ? selected.title as string : "" });
      this.lastSelectedWindowExplicit = this.meetingWindowExplicit;
      let mounted = false;
      if (this.unmountedAvailability !== null) {
        const prepared = await this.preparedContext(); this.requireAttempt(attempt, generation);
        // Start a new read-only OS probe alongside this attempt's server
        // preparation. Stop waits for both so a returned native owner cannot
        // be lost. The source performs another fresh probe before capture.
        const [authorization, probe] = await Promise.allSettled([
          this.options.authorizeMount(prepared, this.signal), this.probeForInitialization(),
        ]);
        if (authorization.status === "rejected") throw authorization.reason;
        const mount = authorization.value; this.requireAttempt(attempt, generation);
        const checked = await this.preparedContext(); this.requireAttempt(attempt, generation);
        if (Object.keys(prepared).some(key => prepared[key as keyof PreparedDesktopCapture] !== checked[key as keyof PreparedDesktopCapture])) throw unavailable();
        const grant = parseBackendCaptureGrant(mount.grant);
        if (mount.status !== "created" || grant.captureSessionId !== this.options.sessionId) throw unavailable();
        this.unmountedAvailability = null;
        // One use, tied to this main-owned attempt. A rejected probe reaches
        // the controller's existing failed-initialization/retirement path.
        this.initializationProbe = { attempt, result: probe };
        await this.controller.initializeFromBackend(grant, crypto.randomUUID());
        this.requireAttempt(attempt, generation);
        if (this.controller.snapshot().state === "permission_required") {
          // No start authority has been requested. Release this unused
          // preparation before allowing a later choice to acquire a fresh one.
          this.unmountedAvailability = "permission_required";
          this.preparationResetPending = true;
          await this.resetUnstartedPreparation();
          return;
        }
        mounted = true;
      }
      this.requireAttempt(attempt, generation);
      // A slow mount/probe can outlive the original visible tab. Recheck this
      // same choice at the actual Start boundary, without spending Start
      // authority on a changed call or selecting a replacement automatically.
      if (mounted && this.audioMode === "meeting" && this.options.listMeetingWindows) {
        await this.checkedInlineWindow(attempt, generation, this.lastSelectedWindow!);
      }
      await this.controller.handleRendererCommand({ schemaVersion: 1, kind: "start", requestId: crypto.randomUUID() });
    } catch (error) {
      this.startFailed = !attempt.signal.aborted;
      throw error;
    } finally { this.selectedWindow = null; this.initializationProbe = null; this.inheritedRecommendedIds.clear(); }
  }
  private async checkedInlineWindow(attempt: AbortController, generation: number,
    expected?: NativeMeetingWindow): Promise<NativeMeetingWindow> {
    const row = this.meetingWindows.find(row => row.id === this.meetingWindowId);
    if (this.meetingWindowsUnavailable) throw this.callSelectionError("capture_call_unavailable");
    if (!row) throw this.callSelectionError("capture_call_selection_required");
    if (expected && !sameCallWindow(row.value, expected)) throw this.callSelectionError("capture_call_changed");
    const explicit = this.meetingWindowExplicit;
    // Re-read before mount/Start authority: a Chrome window may still have the
    // same PID/window ID after its visible tab changes. A changed/ambiguous
    // recommendation is published for a new provider action, never substituted
    // in this attempt. Native capture retains its independent identity checks.
    await this.loadMeetingWindows(AbortSignal.any([this.signal, attempt.signal])); this.requireAttempt(attempt, generation);
    const fresh = this.meetingWindows.find(candidate => sameCallWindow(candidate.value, row.value));
    if (this.meetingWindowsUnavailable) throw this.callSelectionError("capture_call_unavailable");
    if (!fresh) throw this.callSelectionError("capture_call_changed");
    if (!explicit && recommendedCallWindow(this.meetingWindows)?.id !== fresh.id) throw this.callSelectionError("capture_call_selection_required");
    this.meetingWindowId = fresh.id; this.meetingWindowExplicit = explicit; this.publish();
    return fresh.value;
  }
  private callSelectionError(code: NonNullable<DesktopProviderRecorder["callChoiceFailure"]>): Error {
    // Presentation-only fixed reason. Never include a title, native identity or
    // transport error; the current main-owned catalog remains the only choice.
    this.callChoiceFailure = code;
    return unavailable();
  }
  stopRecording(): Promise<void> { this.cancelContinuation(); return this.stopCapture(true); }
  pauseRecording(): Promise<void> { this.cancelContinuation(); return this.stopCapture(false); }
  private stopCapture(upload: boolean, joinInput = true): Promise<void> {
    this.requireOpen();
    if (this.stopping) {
      // Finish may arrive while an interruption is already settling. Preserve
      // that deliberate upload request without starting a second stop owner.
      if (upload && this.stopIntent) this.stopIntent.upload = true;
      return this.stopping;
    }
    if (this.operation && this.action !== "start" && this.action !== "resume") return Promise.reject(unavailable());
    const intent = this.stopIntent = { upload };
    this.stoppingNative = true;
    if (this.action === "start" || this.action === "resume") this.attempt?.abort();
    const prior = this.operation;
    const input = joinInput ? this.inputSwitch : null;
    this.stopping = (async () => {
      try {
        await prior?.catch(() => undefined);
        await input?.catch(() => undefined); this.requireOpen();
        this.unmountedAvailability = null;
        if (this.controller.snapshot().state === "recording") {
          await this.controller.handleRendererCommand({ schemaVersion: 1, kind: "stop", requestId: crypto.randomUUID() });
        } else await this.controller.shutdownFromMain(crypto.randomUUID());
        this.requireOpen();
        this.stoppingNative = false; this.publish();
        if (this.controller.snapshot().state !== "stopped" || this.captureMayBeActive) throw unavailable();
        // Persist the physical pause and stop its lease timer before waiting on
        // the server. A lost reply keeps the same encrypted work and owner retry.
        await this.flow.deactivate();
        this.stopConfirmationPending = true; this.publish();
        await this.options.retireSource(); this.requireOpen();
        this.stopConfirmationPending = false;
        // Server acknowledgement and upload are outside the bounded native stop/indicator operation.
        if (this.flow.snapshot.state === "ready") await this.recoverUnstartedCapture();
        else if (["recording", "paused"].includes(this.flow.snapshot.state)) {
          if (!intent.upload) await this.flow.pauseRecording();
          // Recheck after the durable pause: Finish can be requested while its
          // encrypted state is being saved. Automatic interruption never uploads.
          if (intent.upload) await this.flow.stopRecording();
        } else if (this.flow.snapshot.state === "error") {
          const saved = await this.options.flowStore.getActiveCaptureState(); this.requireOpen();
          if (!saved || saved.sessionId !== this.options.sessionId || saved.phase !== "paused"
            || saved.channel !== "mixed" || saved.reviewAfterUpload !== true) throw unavailable();
          // Physical closure and original-owner retirement are confirmed above.
          // Keep the unknown error; normal same-encounter reopen revalidates the
          // durable state. This changes presentation only, never capture authority.
          this.reopenRequired = true;
        }
      } finally {
        // Clear the shared intent in this same continuation, with no additional
        // promise-finally gap in which a late Finish could be silently lost.
        this.stopping = null; this.stopIntent = null; this.stoppingNative = false; this.publish();
      }
    })();
    this.publish(); return this.stopping;
  }
  resumeRecording(): Promise<void> {
    if (this.switchingInput || this.reconnecting) return Promise.reject(unavailable());
    return this.resumeCapture(this.continuationGeneration);
  }
  private resumeCapture(generation: number): Promise<void> {
    this.requireContinuation(generation);
    if (this.flow.snapshot.state !== "paused" || this.stopConfirmationPending || this.operation || this.stopping) return Promise.reject(unavailable());
    this.startFailed = false;
    this.callChoiceFailure = null;
    const attempt = this.attempt = new AbortController();
    return this.run("resume", async () => {
      let starting = false;
      try {
        // The preceding helper and server owner must both be retired before any renewal.
        await this.controller.shutdownFromMain(crypto.randomUUID()); this.requireAttempt(attempt, generation);
        if (this.controller.snapshot().state !== "stopped" || this.captureMayBeActive) throw unavailable();
        await this.flow.pauseRecording(); this.requireAttempt(attempt, generation);
        this.stopConfirmationPending = true; this.publish();
        await this.options.retireSource(); this.requireAttempt(attempt, generation);
        this.stopConfirmationPending = false;
        if (this.audioMode === "meeting" && this.options.listMeetingWindows) {
          // Expired unused setup has no recorded call to resume. Its first
          // choice still passes the ordinary fresh catalog checks. A prior or
          // unknown capture must keep the original-call fence.
          if (!this.lastSelectedWindow && (!this.unusedSetupKnown || this.continuityUnconfirmed
            || this.coverage !== null || this.flow.snapshot.recordedChunks !== 0)) {
            throw this.callSelectionError("capture_call_selection_required");
          }
          await this.checkedInlineWindow(attempt, generation, this.lastSelectedWindow ?? undefined);
        }
        // Prior native and server ownership is retired. This read-only OS probe
        // is independent of continuation metadata; settle both before proceeding
        // or releasing custody. Start still performs its separate fresh checks.
        const [preparation, availability] = await Promise.allSettled([
          this.flow.prepareContinuation(), this.availability(this.signal),
        ]);
        if (preparation.status === "rejected") throw preparation.reason;
        if (availability.status === "rejected") throw availability.reason;
        this.requireAttempt(attempt, generation);
        const active = await this.options.flowStore.getActiveCaptureState(); this.requireAttempt(attempt, generation);
        if (!active?.continuation?.prepared || !this.options.coverage.beginInterval) throw unavailable();
        await this.options.coverage.beginInterval(active.lease.receipt_id, active.continuation.firstSequenceNumber);
        this.continuityUnconfirmed ||= this.coverage !== null || active.continuation.firstSequenceNumber > 0
          || await this.options.coverage.hasPriorCapture?.(active.lease.receipt_id) !== false;
        this.coverage = await this.options.coverage.load(); this.requireAttempt(attempt, generation);
        this.unsubscribeController(); this.controller = this.createController();
        this.unsubscribeController = this.controller.subscribe(() => this.publish());
        this.unmountedAvailability = availability.value;
        // Preparation and Start share this owner. Stop cancels the ticket before
        // joining it, including while fresh authority or OS readiness is delayed.
        starting = true;
        await this.startAttempt(attempt, generation);
      } catch (error) {
        // Preserve an ordinary failed Start's exact ready continuation for its
        // existing recovery path. Cancellation must pause before Stop can finish.
        if (this.flow.snapshot.state === "ready" && (!starting || attempt.signal.aborted
          || generation !== this.continuationGeneration)) await this.flow.pauseRecording();
        throw error;
      }
    });
  }
  refreshPermissions(): Promise<void> {
    return this.run("other", async () => {
      await this.resetUnstartedPreparation();
      if (this.snapshot.desktop?.phase === "permission_required") {
        await this.requestPermissions(this.signal); this.requireOpen();
      }
      if (this.unmountedAvailability !== null) this.unmountedAvailability = await this.availability(this.signal);
      else await this.controller.handleRendererCommand({ schemaVersion: 1, kind: "refresh_permissions", requestId: crypto.randomUUID() });
    }).then(async () => {
      if (this.audioMode === "meeting" && this.options.listMeetingWindows) await this.refreshMeetingWindows();
    });
  }
  refreshTranscriptionStatus(): Promise<void> { return this.run("other", () => this.flow.refreshTranscriptionStatus()); }
  resumePendingWork(): Promise<void> { return this.run("other", () => this.flow.resumePendingWork()); }
  releaseUploadedCapture(): Promise<void> { return this.run("other", () => this.flow.releaseUploadedCapture()); }

  deactivate(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.deactivated = true; this.cancelContinuation(); this.abort.abort(); this.attempt?.abort();
    this.meetingWindowId = null; this.meetingWindowExplicit = false; this.inheritedRecommendedIds.clear();
    // Interrupt startup now, then await all prior work before releasing custody.
    const halted = this.halt(); void halted.catch(() => undefined);
    this.closing = (async () => {
      await this.initialization?.catch(() => undefined);
      await this.operation?.catch(() => undefined); await this.stopping?.catch(() => undefined);
      await this.inputSwitch?.catch(() => undefined);
      await halted.catch(() => undefined);
      await this.controller.shutdownFromMain(crypto.randomUUID());
      if (this.controller.snapshot().state !== "stopped" || this.captureMayBeActive) throw unavailable();
      await this.halt(); await this.options.retireSource(); await this.options.release(); this.closed = true;
      this.options.signal.removeEventListener("abort", this.onRevocation);
      this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.listeners.clear();
    })().catch(error => { this.closing = null; this.publish(); throw error; });
    this.publish(); return this.closing;
  }
  private readonly onRevocation = (): void => { void this.deactivate().catch(() => undefined); };
  async showWindowChooser(): Promise<void> {
    this.requireOpen();
    const attempt = this.attempt;
    if (!this.choosingWindow || !attempt || attempt.signal.aborted || !["start", "resume"].includes(this.action ?? "")
      || this.stopping || !this.options.showWindowChooser) throw unavailable();
    await this.options.showWindowChooser();
    this.requireOpen();
    if (attempt !== this.attempt || attempt.signal.aborted) throw unavailable();
  }
  private halt(): Promise<void> {
    return this.halting ??= this.flow.deactivate().then(() => { this.captureMayBeActive = false; })
      .finally(() => { this.halting = null; this.publish(); });
  }
  private run(action: "prepare" | "start" | "resume" | "other", work: () => Promise<void>): Promise<void> {
    this.requireOpen();
    if (this.operation || this.stopping || this.initializing && action !== "prepare") return Promise.reject(unavailable());
    this.action = action;
    this.operation = Promise.resolve().then(() => {
      this.requireOpen();
      if (action === "start" || action === "resume") {
        try { this.options.native.diagnostics?.(action === "start" ? "provider_start_requested" : "provider_resume_requested"); }
        catch { /* Diagnostic failure cannot affect capture or cleanup. */ }
      }
      return work();
    }).finally(() => {
      this.operation = null; this.action = null; this.publish();
    });
    this.publish(); return this.operation;
  }
  private requireOpen(): void { if (this.deactivated || this.signal.aborted || this.preparationFailed) throw unavailable(); }
  private subscribeFlow(): () => void {
    return this.flow.subscribe(snapshot => {
      if (!this.deactivated && ["paused", "error"].includes(snapshot.state)
        && (this.controller.snapshot().state === "recording" || this.action === "start" || this.action === "resume" && this.choosingWindow)) {
        // A human picker can outlive the prepared lease. Release that await as
        // soon as setup is invalid, so "starting" cannot mask the expired or
        // failed flow. Cancellation also discards any later native selection.
        if (this.choosingWindow) this.attempt?.abort();
        for (const listener of this.adapterListeners) listener({ kind: "failed" });
        if (snapshot.state === "paused" && this.captureMayBeActive && !this.stopping) {
          // Do not await inside the source callback: its accepted encrypted
          // chunks and pause journal must finish before retirement can settle.
          // Reuse the physical stop and exact server-owner recovery path now,
          // rather than making the provider wait for it on a later Resume.
          const reconnect = this.callReconnectRequested;
          this.callReconnectRequested = false;
          const settled = this.stopCapture(false);
          if (reconnect) void this.reconnectMeeting(settled).catch(() => undefined);
          else void settled.catch(() => undefined);
        }
      }
      this.publish();
    });
  }
  private async reconnectMeeting(settled: Promise<void>): Promise<void> {
    const identity = this.lastSelectedWindow, generation = ++this.reconnectGeneration, continuation = this.continuationGeneration;
    if (!identity || !this.options.listMeetingWindows || this.reconnecting) return;
    this.reconnecting = true; this.publish();
    try {
      await settled; this.requireOpen();
      for (const delay of [0, 1_000, 2_000, 4_000]) {
        if (delay) await new Promise<void>(resolve => { setTimeout(resolve, delay); });
        this.requireOpen();
        if (generation !== this.reconnectGeneration || this.flow.snapshot.state !== "paused" || this.captureMayBeActive
          || this.stopConfirmationPending || this.operation || this.stopping) return;
        await this.loadMeetingWindows(); this.requireOpen();
        if (generation !== this.reconnectGeneration) return;
        const current = this.meetingWindows.find(row => sameCallWindow(row.value, identity));
        if (!current) continue;
        this.meetingWindowId = current.id; this.meetingWindowExplicit = this.lastSelectedWindowExplicit;
        // Fresh metadata, backend continuation and native PID/bundle/window validation
        // occur inside Resume. A failed start never triggers another restart.
        await this.resumeCapture(continuation); return;
      }
    } finally { this.reconnecting = false; this.publish(); }
  }
  private async recoverUnstartedCapture(): Promise<void> {
    const saved = await this.options.flowStore.getActiveCaptureState(); this.requireOpen();
    const firstSequence = saved?.continuation?.firstSequenceNumber ?? 0;
    if (this.flow.snapshot.state !== "ready" || this.flow.snapshot.recordedChunks !== firstSequence
      || this.coverage !== null || this.captureMayBeActive || this.controller.snapshot().state !== "stopped") return;
    // Stop has closed the old controller and cleared the flow's deadline timer.
    // Restore its same durable lease/reservations/key, including expiry checks,
    // only after native stop and server retirement. Never reuse its start grant.
    this.unsubscribeFlow();
    this.flow = this.createFlow();
    this.unsubscribeFlow = this.subscribeFlow();
    try {
      if (!await this.flow.restore()) throw unavailable();
      this.requireOpen();
      if (this.flow.snapshot.state !== "ready") return;
      if (this.flow.snapshot.recordedChunks !== firstSequence) throw unavailable();
      await this.preparedContext();
      this.unsubscribeController();
      this.controller = this.createController();
      this.unsubscribeController = this.controller.subscribe(() => this.publish());
      this.preparationResetPending = false;
      this.unmountedAvailability = await this.availability(this.signal);
    } catch (error) {
      // Revocation may close the host while restore is awaiting a Core read.
      // Do not leave a newly restored deadline timer alive after that closure.
      await this.flow.deactivate();
      throw error;
    }
  }
  private async resetUnstartedPreparation(): Promise<void> {
    if (!this.preparationResetPending) return;
    if (this.flow.snapshot.state !== "ready" || this.captureMayBeActive || this.coverage !== null) throw unavailable();
    await this.controller.shutdownFromMain(crypto.randomUUID()); this.requireOpen();
    if (this.controller.snapshot().state !== "stopped" || this.captureMayBeActive) throw unavailable();
    // A lost retirement reply keeps Record unavailable and retries the same
    // native owner. It never turns permission refresh into a new preparation.
    await this.options.retireSource(); this.requireOpen();
    this.unsubscribeController();
    this.controller = this.createController();
    this.unsubscribeController = this.controller.subscribe(() => this.publish());
    this.preparationResetPending = false;
  }
  private async preparedContext(): Promise<PreparedDesktopCapture> {
    const active = await this.options.flowStore.getActiveCaptureState(); this.requireOpen();
    const uuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
    if (this.flow.snapshot.state !== "ready" || !active || active.phase !== "ready"
      || active.sessionId !== this.options.sessionId || active.channel !== "mixed" || active.reviewAfterUpload !== true
      || active.lease.protocol_version !== "1.0" || active.lease.session_id !== this.options.sessionId
      || !uuid(active.lease.lease_id) || !uuid(active.lease.receipt_id)
      || !Number.isSafeInteger(active.lease.generation) || active.lease.generation < 1
      || active.captureAuthorizedUntil === null
      || !Number.isFinite(Date.parse(active.lease.expires_at))
      || !Number.isFinite(Date.parse(active.captureAuthorizedUntil))
      || Date.parse(active.captureAuthorizedUntil) <= Date.now()
      || Date.parse(active.captureAuthorizedUntil) > Date.parse(active.lease.expires_at)) throw unavailable();
    // Preserve the live accepted count across Pause/Resume. Reopened complete
    // coverage supplies exact duration; unknown legacy history keeps its prior
    // chunk estimate. The storage byte budget can include envelope overhead.
    this.capturePriorAudioFrames = this.capturedAudioFrames ?? this.flow.snapshot.elapsedSeconds * 16_000;
    this.capturedAudioFrames = this.capturePriorAudioFrames;
    return Object.freeze({ sessionId: active.sessionId, captureLeaseId: active.lease.lease_id,
      leaseReceiptId: active.lease.receipt_id, captureLeaseGeneration: active.lease.generation,
      captureAuthorizedUntil: active.captureAuthorizedUntil,
      ...(active.continuation?.firstSequenceNumber ? { firstSequenceNumber: active.continuation.firstSequenceNumber } : {}) });
  }
  private probeForInitialization(): Promise<"ready" | "permission_required"> {
    // Moving the probe ahead of controller initialization must not remove its
    // existing adapter deadline. A late read-only reply cannot be consumed.
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { abort.abort(); reject(unavailable()); }, CAPTURE_OPERATION_TIMEOUT_MS);
    });
    return Promise.race([this.availability(AbortSignal.any([this.signal, abort.signal])), deadline])
      .finally(() => { if (timeout !== undefined) clearTimeout(timeout); });
  }
  private requireStart(): void {
    this.requireOpen();
    if (!this.capability?.secret || !this.attempt || this.attempt.signal.aborted
      || Date.parse(this.capability.expiresAt) <= Date.now()) throw unavailable();
  }
  private cancelContinuation(): void {
    this.continuationGeneration++; this.reconnectGeneration++;
    this.callReconnectRequested = false; this.attempt?.abort();
  }
  private requireContinuation(generation: number): void {
    this.requireOpen();
    if (generation !== this.continuationGeneration) throw unavailable();
  }
  private requireAttempt(attempt: AbortController, generation: number): void {
    this.requireContinuation(generation);
    if (attempt.signal.aborted || this.attempt !== attempt) throw unavailable();
  }
  private publish(): void { for (const listener of this.listeners) { try { listener(this.snapshot); } catch { /* UI cannot break native cleanup. */ } } }
}
function unavailable(): Error { return new Error("Desktop provider recorder is unavailable."); }
function chooseWindow(select: DesktopProviderRecorderOptions["selectWindow"],
  signal: AbortSignal): ReturnType<DesktopProviderRecorderOptions["selectWindow"]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: Awaited<ReturnType<typeof select>>): void => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", cancelled);
      if (value === undefined || signal.aborted) reject(unavailable()); else resolve(value);
    };
    const cancelled = (): void => { finish(); };
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) { finish(); return; }
    // A late native completion can neither restart capture nor restore a
    // selection after stop/revocation. Its rejection is always observed.
    void Promise.resolve().then(() => {
      if (signal.aborted) throw unavailable();
      return select(signal);
    }).then(value => { finish(value); }, () => { finish(); });
  });
}
function milliseconds(a: string, b: string): number { return Number((BigInt(a) + BigInt(b) + 999_999n) / 1_000_000n); }
/** Titles are display metadata. A relaunch or replacement window requires a
 * fresh provider choice, even if its title happens to match the prior call. */
export function sameMeetingWindow(a: NativeMeetingWindow, b: NativeMeetingWindow): boolean {
  return a.application === b.application && a.processID === b.processID && a.windowID === b.windowID;
}
