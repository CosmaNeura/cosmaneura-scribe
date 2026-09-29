import { CaptureFlowController, type CaptureSessionKeyFactory } from "../../capture/src/flow/controller";
import type { CaptureFlowStore } from "../../capture/src/flow/types";
import type { CaptureStorageCapacity } from "../../capture/src/flow/storage-capacity";
import type { CreatorReviewView } from "../../review-ui/src/creator-review-api";
import { CaptureQueue } from "../../capture/src/queue/capture-queue";
import type { CaptureQueueStorage } from "../../capture/src/queue/types";
import type { CaptureBff, CiphertextUploadTarget } from "../../capture/src/bff/contracts";
import { BffCaptureQueueTransport } from "../../capture/src/bff/queue-transport";
import type { ProviderRecorderController, ProviderRecorderSnapshot } from "../../capture/src/provider-binding";
import { DesktopCaptureController, type DesktopCaptureControllerOptions } from "./controller.js";
import type { AdapterSignal, DesktopCaptureAdapter } from "./capture-adapter.js";
import type { PersistentRecordingIndicator } from "./recording-indicator.js";
import { parseBackendCaptureGrant, type OneTimeCaptureCapability } from "./protocol.js";
import { DesktopPcmCaptureSource } from "./pcm-capture-source.js";
import type { DesktopPCMCoverage } from "./native-pcm-driver.js";
import { NativeProcessPCMDriver, type AuthorizedDesktopSelection, type NativeProcessDriverOptions } from "./native-process-driver.js";

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
  /** Selected by the trusted beta host; direct/diagnostic compositions default off. */
  readonly uploadWhileRecording?: boolean;
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
    hasPriorCapture?(receiptId: string): Promise<boolean> };
  readonly native: Omit<NativeProcessDriverOptions, "enabled" | "authorizeSelectedWindow">;
  /** Native picker, deliberate choice only; never a renderer PID or first window. */
  readonly selectWindow: (signal: AbortSignal) => Promise<Omit<AuthorizedDesktopSelection, "captureAuthorizedUntil">>;
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
  private readonly listeners = new Set<(value: ProviderRecorderSnapshot) => void>();
  private readonly adapterListeners = new Set<(value: AdapterSignal) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private coverage: DesktopPCMCoverage | null = null;
  private continuityUnconfirmed = false;
  private capability: OneTimeCaptureCapability | null = null;
  private attempt: AbortController | null = null;
  private selectedWindow: Omit<AuthorizedDesktopSelection, "captureAuthorizedUntil"> | null = null;
  private choosingWindow = false;
  private startFailed = false;
  private operation: Promise<void> | null = null;
  private action: "prepare" | "start" | "other" | null = null;
  private stopping: Promise<void> | null = null;
  private stoppingNative = false;
  private stopConfirmationPending = false;
  private reopenRequired = false;
  private halting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private deactivated = false;
  private closed = false;
  private captureMayBeActive = false;

  private constructor(private readonly options: DesktopProviderRecorderOptions) {
    if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
      || "type" in process && process.type === "renderer" || options.enabled !== true
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.sessionId) || options.signal.aborted) throw unavailable();
    this.signal = AbortSignal.any([options.signal, this.abort.signal]);
    const driver = new NativeProcessPCMDriver({ ...options.native, enabled: true,
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
    });
    const bff = options.createBff(this.signal);
    this.createFlow = () => new CaptureFlowController({ bff, flowStore: options.flowStore, createSessionKey: options.createSessionKey,
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
      initialize: availability, refreshPermissions: availability,
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
    options.signal.addEventListener("abort", this.onRevocation, { once: true });
  }

  static async open(options: DesktopProviderRecorderOptions): Promise<DesktopProviderRecorder> {
    options = Object.freeze({ ...options, native: Object.freeze({ ...options.native }) });
    const recorder = new DesktopProviderRecorder(options);
    try {
      await recorder.run("prepare", async () => {
        const current = Object.freeze({ ...await options.authorizePreparation(recorder.signal) }); recorder.requireOpen();
        if (current.sessionId !== options.sessionId || ![
          "created", "capturing", "uploaded", "processing", "speech_failed", "speech_retryable",
          "handed_off", "translation_pending", "review_required", "transcript_ready", "quality_blocked",
        ].includes(current.status)) throw unavailable();
        const active = await options.flowStore.getActiveCaptureState(), preparing = await options.flowStore.getPreparationState();
        recorder.requireOpen();
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
        recorder.coverage = await options.coverage.load(); recorder.requireOpen();
        recorder.continuityUnconfirmed = active?.continuation !== undefined;
        if (!await recorder.flow.restore()) await recorder.flow.prepareConfigured(options.sessionId);
        recorder.requireOpen();
        if (recorder.flow.snapshot.sessionId !== options.sessionId) throw unavailable();
        if (recorder.flow.snapshot.state === "ready") {
          if (active?.continuation) {
            if (!options.coverage.beginInterval) throw unavailable();
            await options.coverage.beginInterval(active.lease.receipt_id, active.continuation.firstSequenceNumber);
            recorder.coverage = await options.coverage.load(); recorder.requireOpen();
          }
          if (recorder.coverage !== null) throw unavailable(); // Never replay an attempt over retained coverage.
          if (!mayRestoreReady) throw unavailable();
          await recorder.preparedContext();
          recorder.unmountedAvailability = await recorder.availability(recorder.signal);
        }
        if (active?.continuation) {
          recorder.continuityUnconfirmed = active.continuation.firstSequenceNumber > 0
            || await options.coverage.hasPriorCapture?.(active.lease.receipt_id) !== false;
          recorder.requireOpen();
        }
      });
      return recorder;
    } catch (error) { await recorder.deactivate(); throw error; }
  }

  get snapshot(): ProviderRecorderSnapshot {
    const flow = this.flow.snapshot, control = this.controller.snapshot();
    const phase = this.captureMayBeActive && control.state === "failed" ? "stop_unconfirmed"
      : this.stoppingNative || this.closing && !this.closed ? "stopping"
      : this.stopping && !this.captureMayBeActive ? "stopped"
      : this.reopenRequired && flow.state === "error" ? "stopped"
      : this.action === "start" ? "starting" : control.state === "recording" && flow.state === "recording" ? "recording"
      : control.state === "permission_required" || this.unmountedAvailability === "permission_required" ? "permission_required"
      : flow.state === "ready" && (control.state === "ready" || this.unmountedAvailability === "ready") ? "ready"
      : ["paused", "error", "ready", "recording"].includes(flow.state) && !this.closed ? "interrupted" : "stopped";
    const start = this.coverage?.phase === "started" ? this.coverage.value : this.coverage?.value.start;
    const setupExpired = phase === "interrupted" && flow.statusCode === "capture_authority_expired"
      && !this.captureMayBeActive && !this.continuityUnconfirmed && this.coverage === null && flow.recordedChunks === 0;
    return { ...flow, statusCode: this.stopConfirmationPending ? "capture_stop_acknowledgement_pending"
      : this.stopping && phase === "stopped" && flow.state === "recording" ? "capture_upload_settling"
      : this.reopenRequired && flow.state === "error" ? "capture_reopen_required"
      : setupExpired ? "capture_setup_expired"
      : phase === "ready" && this.startFailed && flow.statusCode !== "capture_storage_low" ? "capture_start_failed"
      : this.choosingWindow ? "capture_window_selection_pending" : flow.statusCode,
      sessionId: this.options.sessionId, transcript: null, transcriptionStatus: null,
      desktop: { phase, coverage: this.continuityUnconfirmed ? "incomplete" : this.coverage?.phase === "stopped" ? "complete"
        : this.coverage ? phase === "recording" ? "aligned" : "incomplete" : "not_started",
      trimmedStartMs: start ? milliseconds(start.microphonePrerollNanoseconds, start.systemPrerollNanoseconds) : 0,
      trimmedEndMs: this.coverage?.phase === "stopped"
        ? milliseconds(this.coverage.value.microphoneTailNanoseconds, this.coverage.value.systemTailNanoseconds) : null } };
  }
  get availableForView(): boolean { return !this.deactivated && !this.signal.aborted; }
  subscribe(listener: (value: ProviderRecorderSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener);
  }
  startRecording(): Promise<void> {
    this.requireOpen();
    if (this.snapshot.desktop?.phase !== "ready" || this.stopping) return Promise.reject(unavailable());
    this.startFailed = false;
    this.attempt = new AbortController();
    const attempt = this.attempt;
    return this.run("start", async () => {
      // Human window choice precedes the fresh server decision and the native
      // helper's bounded startup. No grant or active indicator is spent waiting
      // for a person to choose. The native source still revalidates the window.
      try {
        await this.flow.checkStorageCapacity(); this.requireOpen();
        this.choosingWindow = true; this.publish();
        let selected: Awaited<ReturnType<DesktopProviderRecorderOptions["selectWindow"]>>;
        try { selected = await chooseWindow(this.options.selectWindow, attempt.signal); }
        finally { this.choosingWindow = false; this.publish(); }
        this.requireOpen();
        if (attempt.signal.aborted || this.attempt !== attempt) throw unavailable();
        this.selectedWindow = Object.freeze({ application: selected.application,
          processID: selected.processID, windowID: selected.windowID });
        if (this.unmountedAvailability !== null) {
          const prepared = await this.preparedContext();
          // A Stop waits for this bounded request so its returned native owner
          // can be retired. Aborting the choice alone must not lose that owner.
          const mount = await this.options.authorizeMount(prepared, this.signal); this.requireOpen();
          if (attempt.signal.aborted || this.attempt !== attempt) throw unavailable();
          const checked = await this.preparedContext();
          if (Object.keys(prepared).some(key => prepared[key as keyof PreparedDesktopCapture] !== checked[key as keyof PreparedDesktopCapture])) throw unavailable();
          const grant = parseBackendCaptureGrant(mount.grant);
          if (mount.status !== "created" || grant.captureSessionId !== this.options.sessionId) throw unavailable();
          this.unmountedAvailability = null;
          await this.controller.initializeFromBackend(grant, crypto.randomUUID());
          this.requireOpen();
          if (attempt.signal.aborted || this.attempt !== attempt) throw unavailable();
          if (this.controller.snapshot().state === "permission_required") {
            // No start authority has been requested. Release this unused
            // preparation before allowing a later choice to acquire a fresh one.
            this.unmountedAvailability = "permission_required";
            this.preparationResetPending = true;
            await this.resetUnstartedPreparation();
            return;
          }
        }
        await this.controller.handleRendererCommand({ schemaVersion: 1, kind: "start", requestId: crypto.randomUUID() });
      } catch (error) {
        this.startFailed = !attempt.signal.aborted;
        throw error;
      } finally { this.selectedWindow = null; }
    });
  }
  stopRecording(): Promise<void> { return this.stopCapture(true); }
  pauseRecording(): Promise<void> { return this.stopCapture(false); }
  private stopCapture(upload: boolean): Promise<void> {
    this.requireOpen();
    if (this.stopping) return this.stopping;
    if (this.operation && this.action !== "start") return Promise.reject(unavailable());
    this.stoppingNative = true;
    if (this.action === "start") this.attempt?.abort();
    const prior = this.operation;
    this.stopping = (async () => {
      await prior?.catch(() => undefined); this.requireOpen();
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
        if (upload) await this.flow.stopRecording(); else await this.flow.pauseRecording();
      } else if (this.flow.snapshot.state === "error") {
        const saved = await this.options.flowStore.getActiveCaptureState(); this.requireOpen();
        if (!saved || saved.sessionId !== this.options.sessionId || saved.phase !== "paused"
          || saved.channel !== "mixed" || saved.reviewAfterUpload !== true) throw unavailable();
        // Physical closure and original-owner retirement are confirmed above.
        // Keep the unknown error; normal same-encounter reopen revalidates the
        // durable state. This changes presentation only, never capture authority.
        this.reopenRequired = true;
      }
    })().finally(() => { this.stopping = null; this.stoppingNative = false; this.publish(); });
    this.publish(); return this.stopping;
  }
  resumeRecording(): Promise<void> {
    if (this.flow.snapshot.state !== "paused") return Promise.reject(unavailable());
    return this.run("other", async () => {
      // The preceding helper and server owner must both be retired before any renewal.
      await this.controller.shutdownFromMain(crypto.randomUUID()); this.requireOpen();
      if (this.controller.snapshot().state !== "stopped" || this.captureMayBeActive) throw unavailable();
      await this.flow.pauseRecording();
      this.stopConfirmationPending = true; this.publish();
      await this.options.retireSource(); this.requireOpen();
      this.stopConfirmationPending = false;
      await this.flow.prepareContinuation(); this.requireOpen();
      const active = await this.options.flowStore.getActiveCaptureState(); this.requireOpen();
      if (!active?.continuation?.prepared || !this.options.coverage.beginInterval) throw unavailable();
      await this.options.coverage.beginInterval(active.lease.receipt_id, active.continuation.firstSequenceNumber);
      this.continuityUnconfirmed ||= this.coverage !== null || active.continuation.firstSequenceNumber > 0
        || await this.options.coverage.hasPriorCapture?.(active.lease.receipt_id) !== false;
      this.coverage = await this.options.coverage.load(); this.requireOpen();
      this.unsubscribeController(); this.controller = this.createController();
      this.unsubscribeController = this.controller.subscribe(() => this.publish());
      this.unmountedAvailability = await this.availability(this.signal);
    }).catch(async error => {
      if (this.flow.snapshot.state === "ready") await this.flow.pauseRecording();
      throw error;
    }).then(() => this.startRecording());
  }
  refreshPermissions(): Promise<void> {
    return this.run("other", async () => {
      await this.resetUnstartedPreparation();
      if (this.snapshot.desktop?.phase === "permission_required") {
        await this.requestPermissions(this.signal); this.requireOpen();
      }
      if (this.unmountedAvailability !== null) this.unmountedAvailability = await this.availability(this.signal);
      else await this.controller.handleRendererCommand({ schemaVersion: 1, kind: "refresh_permissions", requestId: crypto.randomUUID() });
    });
  }
  refreshTranscriptionStatus(): Promise<void> { return this.run("other", () => this.flow.refreshTranscriptionStatus()); }
  resumePendingWork(): Promise<void> { return this.run("other", () => this.flow.resumePendingWork()); }
  releaseUploadedCapture(): Promise<void> { return this.run("other", () => this.flow.releaseUploadedCapture()); }

  deactivate(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.deactivated = true; this.abort.abort(); this.attempt?.abort();
    // Interrupt startup now, then await all prior work before releasing custody.
    const halted = this.halt(); void halted.catch(() => undefined);
    this.closing = (async () => {
      await this.operation?.catch(() => undefined); await this.stopping?.catch(() => undefined);
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
  private halt(): Promise<void> {
    return this.halting ??= this.flow.deactivate().then(() => { this.captureMayBeActive = false; })
      .finally(() => { this.halting = null; this.publish(); });
  }
  private run(action: "prepare" | "start" | "other", work: () => Promise<void>): Promise<void> {
    this.requireOpen();
    if (this.operation || this.stopping) return Promise.reject(unavailable());
    this.action = action;
    this.operation = Promise.resolve().then(() => { this.requireOpen(); return work(); }).finally(() => {
      this.operation = null; this.action = null; this.publish();
    });
    this.publish(); return this.operation;
  }
  private requireOpen(): void { if (this.deactivated || this.signal.aborted) throw unavailable(); }
  private subscribeFlow(): () => void {
    return this.flow.subscribe(snapshot => {
      if (!this.deactivated && ["paused", "error"].includes(snapshot.state)
        && (this.controller.snapshot().state === "recording" || this.action === "start")) {
        for (const listener of this.adapterListeners) listener({ kind: "failed" });
      }
      this.publish();
    });
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
    return Object.freeze({ sessionId: active.sessionId, captureLeaseId: active.lease.lease_id,
      leaseReceiptId: active.lease.receipt_id, captureLeaseGeneration: active.lease.generation,
      captureAuthorizedUntil: active.captureAuthorizedUntil,
      ...(active.continuation?.firstSequenceNumber ? { firstSequenceNumber: active.continuation.firstSequenceNumber } : {}) });
  }
  private requireStart(): void {
    this.requireOpen();
    if (!this.capability?.secret || !this.attempt || this.attempt.signal.aborted
      || Date.parse(this.capability.expiresAt) <= Date.now()) throw unavailable();
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
