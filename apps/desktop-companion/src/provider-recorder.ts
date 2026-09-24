import { CaptureFlowController, type CaptureSessionKeyFactory } from "../../capture/src/flow/controller";
import type { CaptureFlowStore } from "../../capture/src/flow/types";
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

export interface DesktopProviderRecorderOptions {
  readonly enabled?: boolean;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  /** Existing authenticated Core transport, bound to this cancellation signal. */
  readonly createBff: (signal: AbortSignal) => CaptureBff;
  /** Reauthorize this creator/encounter/session through the trusted backend. */
  readonly authorizeMount: (signal: AbortSignal) => Promise<{ readonly grant: unknown; readonly status: "created" | "capturing" }>;
  readonly authority: NonNullable<DesktopCaptureControllerOptions["authority"]>;
  readonly indicator: PersistentRecordingIndicator;
  readonly flowStore: CaptureFlowStore;
  readonly createSessionKey: CaptureSessionKeyFactory;
  readonly queueStorage: CaptureQueueStorage;
  readonly uploadTarget: CiphertextUploadTarget;
  readonly coverage: { load(): Promise<DesktopPCMCoverage | null>; persist(value: DesktopPCMCoverage): Promise<void> };
  readonly native: Omit<NativeProcessDriverOptions, "enabled" | "authorizeSelectedWindow">;
  /** Native picker, deliberate choice only; never a renderer PID or first window. */
  readonly selectWindow: (signal: AbortSignal) => Promise<Omit<AuthorizedDesktopSelection, "captureAuthorizedUntil">>;
  /** Close creator-scoped stores and release exclusive host ownership after stop. */
  readonly release: () => Promise<void>;
}

/** Trusted main composition. No identity, grant, storage key, helper path or
 * window selection can be supplied by its renderer view. Default disabled. */
export class DesktopProviderRecorder implements ProviderRecorderController {
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly flow: CaptureFlowController;
  private readonly source: DesktopPcmCaptureSource;
  private readonly controller: DesktopCaptureController;
  private readonly listeners = new Set<(value: ProviderRecorderSnapshot) => void>();
  private readonly adapterListeners = new Set<(value: AdapterSignal) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private coverage: DesktopPCMCoverage | null = null;
  private capability: OneTimeCaptureCapability | null = null;
  private attempt: AbortController | null = null;
  private operation: Promise<void> | null = null;
  private action: "prepare" | "start" | "other" | null = null;
  private stopping: Promise<void> | null = null;
  private stoppingNative = false;
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
        const selection = await options.selectWindow(this.attempt!.signal);
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
    this.flow = new CaptureFlowController({ bff, flowStore: options.flowStore, createSessionKey: options.createSessionKey,
      source: this.source, queue: new CaptureQueue(options.queueStorage),
      queueTransport: new BffCaptureQueueTransport(bff, options.uploadTarget) });
    const availability = async (signal: AbortSignal): Promise<"ready" | "permission_required"> => {
      this.requireOpen(); if (signal.aborted) throw unavailable();
      const available = await driver.getAvailability();
      this.requireOpen(); if (signal.aborted) throw unavailable();
      return available ? "ready" : "permission_required";
    };
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
    this.controller = new DesktopCaptureController(adapter, options.indicator, { enabled: true,
      authority: { authorizeStart: async (grant, signal) => {
        this.requireOpen();
        if (!this.attempt) throw unavailable();
        const linked = AbortSignal.any([signal, this.signal, this.attempt.signal]);
        if (linked.aborted) throw unavailable();
        const decision = await options.authority.authorizeStart(grant, linked);
        if (linked.aborted) throw unavailable();
        return decision;
      } } });
    this.unsubscribe.push(this.controller.subscribe(() => this.publish()), this.flow.subscribe(snapshot => {
      if (!this.deactivated && ["paused", "error"].includes(snapshot.state)
        && (this.controller.snapshot().state === "recording" || this.action === "start")) {
        for (const listener of this.adapterListeners) listener({ kind: "failed" });
      }
      this.publish();
    }));
    options.signal.addEventListener("abort", this.onRevocation, { once: true });
  }

  static async open(options: DesktopProviderRecorderOptions): Promise<DesktopProviderRecorder> {
    options = Object.freeze({ ...options, native: Object.freeze({ ...options.native }) });
    const recorder = new DesktopProviderRecorder(options);
    try {
      await recorder.run("prepare", async () => {
        const mount = await options.authorizeMount(recorder.signal); recorder.requireOpen();
        const grant = parseBackendCaptureGrant(mount.grant);
        if (grant.captureSessionId !== options.sessionId || !["created", "capturing"].includes(mount.status)) throw unavailable();
        const active = await options.flowStore.getActiveCaptureState(), preparing = await options.flowStore.getPreparationState();
        recorder.requireOpen();
        if (active && (active.sessionId !== options.sessionId || active.reviewAfterUpload !== true || active.channel !== "mixed")
          || preparing && (preparing.sessionId !== options.sessionId || preparing.mode !== "configured_core" || preparing.channel !== "mixed")
          || mount.status === "capturing" && active === null && preparing === null) throw unavailable();
        recorder.coverage = await options.coverage.load(); recorder.requireOpen();
        if (!await recorder.flow.restore()) await recorder.flow.prepareConfigured(options.sessionId);
        recorder.requireOpen();
        if (recorder.flow.snapshot.sessionId !== options.sessionId) throw unavailable();
        if (recorder.flow.snapshot.state === "ready") {
          if (recorder.coverage !== null) throw unavailable(); // Never replay an attempt over retained coverage.
          await recorder.controller.initializeFromBackend(grant, crypto.randomUUID());
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
      : this.action === "start" ? "starting" : control.state === "recording" && flow.state === "recording" ? "recording"
      : control.state === "permission_required" ? "permission_required"
      : flow.state === "ready" && control.state === "ready" ? "ready"
      : ["paused", "error", "ready", "recording"].includes(flow.state) && !this.closed ? "interrupted" : "stopped";
    const start = this.coverage?.phase === "started" ? this.coverage.value : this.coverage?.value.start;
    return { ...flow, sessionId: this.options.sessionId, transcript: null, transcriptionStatus: null,
      desktop: { phase, coverage: this.coverage?.phase === "stopped" ? "complete"
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
    this.attempt = new AbortController();
    return this.run("start", () => this.controller.handleRendererCommand({ schemaVersion: 1, kind: "start", requestId: crypto.randomUUID() }));
  }
  stopRecording(): Promise<void> {
    this.requireOpen();
    if (this.stopping) return this.stopping;
    if (this.operation && this.action !== "start") return Promise.reject(unavailable());
    this.stoppingNative = true;
    if (this.action === "start") this.attempt?.abort();
    const prior = this.operation;
    this.stopping = (async () => {
      await prior?.catch(() => undefined); this.requireOpen();
      if (this.controller.snapshot().state === "recording") {
        await this.controller.handleRendererCommand({ schemaVersion: 1, kind: "stop", requestId: crypto.randomUUID() });
      } else await this.controller.shutdownFromMain(crypto.randomUUID());
      this.requireOpen();
      this.stoppingNative = false; this.publish();
      // Upload is outside the bounded native stop/indicator operation.
      if (["recording", "paused"].includes(this.flow.snapshot.state)) await this.flow.stopRecording();
    })().finally(() => { this.stopping = null; this.stoppingNative = false; this.publish(); });
    this.publish(); return this.stopping;
  }
  refreshPermissions(): Promise<void> {
    return this.run("other", () => this.controller.handleRendererCommand({ schemaVersion: 1, kind: "refresh_permissions", requestId: crypto.randomUUID() }));
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
      await this.halt(); await this.options.release(); this.closed = true;
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
  private requireStart(): void {
    this.requireOpen();
    if (!this.capability?.secret || !this.attempt || this.attempt.signal.aborted
      || Date.parse(this.capability.expiresAt) <= Date.now()) throw unavailable();
  }
  private publish(): void { for (const listener of this.listeners) { try { listener(this.snapshot); } catch { /* UI cannot break native cleanup. */ } } }
}
function unavailable(): Error { return new Error("Desktop provider recorder is unavailable."); }
function milliseconds(a: string, b: string): number { return Number((BigInt(a) + BigInt(b) + 999_999n) / 1_000_000n); }
