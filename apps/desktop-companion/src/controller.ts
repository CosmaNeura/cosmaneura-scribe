import type {
  AdapterSignal,
  DesktopCaptureAdapter,
} from "./capture-adapter.js";
import {
  CaptureAuthorityError,
  DenyAllCaptureAuthority,
  processCapabilityRegistry,
  validateFreshStartAuthority,
  type OneTimeCapabilityRegistry,
  type TrustedCaptureAuthority,
} from "./capture-authority.js";
import {
  CAPTURE_OPERATION_TIMEOUT_MS,
  ELECTRON_IPC_SCHEMA_VERSION,
  START_AUTHORITY_TIMEOUT_MS,
} from "./config.js";
import type {
  PersistentRecordingIndicator,
  RecordingIndicatorSnapshot,
} from "./recording-indicator.js";
import {
  createRecordingLeaseOwner,
  processRecordingLease,
  RecordingLeaseUnavailableError,
  type RecordingLeaseOwner,
  type SingleRecordingLease,
} from "./recording-lease.js";
import {
  parseBackendCaptureGrant,
  parseMetadataIdentifier,
  parseRendererCommand,
  type BackendCaptureGrant,
  type CompanionState,
  type ControllerStateEvent,
  type FailureCode,
  ProtocolValidationError,
  type OneTimeCaptureCapability,
  type RendererCommand,
  wipeCaptureCapability,
} from "./protocol.js";

export interface DesktopCaptureControllerOptions {
  readonly enabled?: boolean;
  readonly clock?: () => Date;
  readonly lease?: SingleRecordingLease;
  readonly authority?: TrustedCaptureAuthority;
  readonly capabilityRegistry?: OneTimeCapabilityRegistry;
  readonly authorityTimeoutMs?: number;
  readonly captureOperationTimeoutMs?: number;
}

export class CompanionControllerError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super("Desktop companion command failed");
    this.name = "CompanionControllerError";
    this.code = code;
  }
}

export class DesktopCaptureController {
  readonly #adapter: DesktopCaptureAdapter;
  readonly #indicator: PersistentRecordingIndicator;
  readonly #enabled: boolean;
  readonly #clock: () => Date;
  readonly #lease: SingleRecordingLease;
  readonly #authority: TrustedCaptureAuthority;
  readonly #capabilityRegistry: OneTimeCapabilityRegistry;
  readonly #authorityTimeoutMs: number;
  readonly #captureOperationTimeoutMs: number;
  readonly #leaseOwner: RecordingLeaseOwner = createRecordingLeaseOwner();
  readonly #listeners = new Set<(event: ControllerStateEvent) => void>();
  readonly #unsubscribeAdapter: () => void;
  #state: CompanionState = "stopped";
  #reasonCode: FailureCode | null = null;
  #grant: BackendCaptureGrant | null = null;
  #captureSessionId: string | null = null;
  #captureMayBeActive = false;
  #leaseHeld = false;
  #closed = false;
  #operationWork: Promise<void> = Promise.resolve();

  constructor(
    adapter: DesktopCaptureAdapter,
    indicator: PersistentRecordingIndicator,
    options: DesktopCaptureControllerOptions = {},
  ) {
    this.#adapter = adapter;
    this.#indicator = indicator;
    this.#enabled = options.enabled ?? false;
    this.#clock = options.clock ?? (() => new Date());
    this.#lease = options.lease ?? processRecordingLease;
    this.#authority = options.authority ?? new DenyAllCaptureAuthority();
    this.#capabilityRegistry =
      options.capabilityRegistry ?? processCapabilityRegistry;
    this.#authorityTimeoutMs =
      options.authorityTimeoutMs ?? START_AUTHORITY_TIMEOUT_MS;
    this.#captureOperationTimeoutMs =
      options.captureOperationTimeoutMs ?? CAPTURE_OPERATION_TIMEOUT_MS;
    if (
      !Number.isInteger(this.#authorityTimeoutMs) ||
      this.#authorityTimeoutMs < 1 ||
      this.#authorityTimeoutMs > START_AUTHORITY_TIMEOUT_MS
    ) {
      throw new RangeError("Invalid capture authority timeout");
    }
    if (
      !Number.isInteger(this.#captureOperationTimeoutMs) ||
      this.#captureOperationTimeoutMs < 1 ||
      this.#captureOperationTimeoutMs > CAPTURE_OPERATION_TIMEOUT_MS
    ) {
      throw new RangeError("Invalid capture operation timeout");
    }
    this.#unsubscribeAdapter = this.#adapter.onSignal((signal) => {
      this.#enqueue(async () => this.#handleAdapterSignal(signal)).catch(
        () => undefined,
      );
    });
  }

  snapshot(): ControllerStateEvent {
    return Object.freeze({
      schemaVersion: ELECTRON_IPC_SCHEMA_VERSION,
      requestId: null,
      state: this.#state,
      captureSessionId: this.#captureSessionId,
      reasonCode: this.#reasonCode,
    });
  }

  subscribe(listener: (event: ControllerStateEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async initializeFromBackend(grant: unknown, requestId: unknown): Promise<void> {
    const validatedGrant = parseBackendCaptureGrant(grant);
    const validatedRequestId = parseMetadataIdentifier(requestId);
    await this.#enqueue(async () =>
      this.#initialize(validatedGrant, validatedRequestId),
    );
  }

  async handleRendererCommand(command: unknown): Promise<void> {
    const validated = parseRendererCommand(command);
    await this.#enqueue(async () => this.#handleRendererCommand(validated));
  }

  async shutdownFromMain(requestId: unknown): Promise<void> {
    const validatedRequestId = parseMetadataIdentifier(requestId);
    await this.#enqueue(async () => this.#shutdown(validatedRequestId));
  }

  async settled(): Promise<void> {
    await this.#operationWork;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#operationWork.then(operation);
    this.#operationWork = result.catch(() => undefined);
    return result;
  }

  async #initialize(
    grant: BackendCaptureGrant,
    requestId: string,
  ): Promise<void> {
    if (!this.#enabled) {
      throw new CompanionControllerError("feature_disabled");
    }
    if (this.#closed || this.#state !== "stopped" || this.#grant !== null) {
      throw new CompanionControllerError("invalid_transition");
    }
    this.#grant = grant;
    this.#captureSessionId = grant.captureSessionId;
    try {
      const state = await this.#runBoundedAdapterOperation((signal) =>
        this.#adapter.initialize(signal),
      );
      this.#transition(state, requestId, null);
    } catch {
      this.#grant = null;
      this.#transition("failed", requestId, "adapter_failure");
      throw new CompanionControllerError("adapter_failure");
    }
  }

  async #handleRendererCommand(command: RendererCommand): Promise<void> {
    if (!this.#enabled) {
      throw new CompanionControllerError("feature_disabled");
    }
    if (this.#closed || this.#state === "failed") {
      throw new CompanionControllerError("invalid_transition");
    }

    switch (command.kind) {
      case "refresh_permissions":
        await this.#refreshPermissions(command.requestId);
        return;
      case "start":
        await this.#start(command.requestId);
        return;
      case "stop":
        await this.#stop(command.requestId);
        return;
    }
  }

  async #refreshPermissions(requestId: string): Promise<void> {
    this.#requireGrant();
    if (
      this.#state !== "permission_required" &&
      this.#state !== "meeting_detected" &&
      this.#state !== "ready"
    ) {
      throw new CompanionControllerError("invalid_transition");
    }
    try {
      this.#transition(
        await this.#runBoundedAdapterOperation((signal) =>
          this.#adapter.refreshPermissions(signal),
        ),
        requestId,
        null,
      );
    } catch {
      await this.#terminalFailure("adapter_failure", requestId);
      throw new CompanionControllerError("adapter_failure");
    }
  }

  async #start(requestId: string): Promise<void> {
    const grant = this.#requireGrant();
    if (this.#state !== "ready") {
      throw new CompanionControllerError("precondition_failed");
    }
    try {
      this.#lease.acquire(this.#leaseOwner);
      this.#leaseHeld = true;
    } catch (error) {
      if (error instanceof RecordingLeaseUnavailableError) {
        throw new CompanionControllerError("lease_unavailable");
      }
      throw error;
    }

    let capability: OneTimeCaptureCapability;
    try {
      capability = await this.#authorizeImmediatelyBeforeStart(grant);
    } catch (error) {
      const code = authorityFailureCode(error);
      this.#grant = null;
      this.#releaseLease();
      this.#transition("failed", requestId, code);
      throw new CompanionControllerError(code);
    }
    try {
      this.#capabilityRegistry.consume(capability.capabilityId);
    } catch (error) {
      wipeCaptureCapability(capability);
      const code = authorityFailureCode(error);
      this.#grant = null;
      this.#releaseLease();
      this.#transition("failed", requestId, code);
      throw new CompanionControllerError(code);
    }

    try {
      await this.#indicator.publish(this.#activeIndicator("recording"));
    } catch {
      wipeCaptureCapability(capability);
      this.#releaseLease();
      this.#grant = null;
      this.#transition("failed", requestId, "indicator_failure");
      throw new CompanionControllerError("indicator_failure");
    }

    if (Date.parse(capability.expiresAt) <= this.#clock().getTime()) {
      wipeCaptureCapability(capability);
      try {
        await this.#indicator.publish(this.#inactiveIndicator());
        this.#releaseLease();
      } catch {
        this.#grant = null;
        this.#transition("failed", requestId, "indicator_failure");
        throw new CompanionControllerError("indicator_failure");
      }
      this.#grant = null;
      this.#transition("failed", requestId, "authority_stale");
      throw new CompanionControllerError("authority_stale");
    }

    this.#captureMayBeActive = true;
    try {
      await this.#startAdapter(capability);
      this.#transition("recording", requestId, null);
    } catch {
      wipeCaptureCapability(capability);
      await this.#terminalFailure("adapter_failure", requestId);
      throw new CompanionControllerError("adapter_failure");
    } finally {
      wipeCaptureCapability(capability);
    }
  }

  async #startAdapter(capability: OneTimeCaptureCapability): Promise<void> {
    await this.#runBoundedAdapterOperation((signal) =>
      this.#adapter.start(capability, signal),
    );
  }

  async #runBoundedAdapterOperation<Result>(
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new Error("Capture adapter operation timed out"));
      }, this.#captureOperationTimeoutMs);
    });
    try {
      return await Promise.race([
        operation(abortController.signal),
        timedOut,
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async #authorizeImmediatelyBeforeStart(
    grant: BackendCaptureGrant,
  ): Promise<OneTimeCaptureCapability> {
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new CaptureAuthorityError("authority_unavailable"));
      }, this.#authorityTimeoutMs);
    });
    try {
      const decision = await Promise.race([
        this.#authority.authorizeStart(grant, abortController.signal),
        timedOut,
      ]);
      return validateFreshStartAuthority(decision, grant, this.#clock());
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  async #stop(requestId: string): Promise<void> {
    if (this.#state !== "recording") {
      throw new CompanionControllerError("invalid_transition");
    }
    try {
      await this.#runBoundedAdapterOperation((signal) =>
        this.#adapter.stop(signal),
      );
      this.#captureMayBeActive = false;
    } catch {
      await this.#terminalFailure("adapter_failure", requestId);
      throw new CompanionControllerError("adapter_failure");
    }

    try {
      await this.#indicator.publish(this.#inactiveIndicator());
    } catch {
      this.#grant = null;
      this.#transition("failed", requestId, "indicator_failure");
      throw new CompanionControllerError("indicator_failure");
    }

    this.#releaseLease();
    this.#grant = null;
    this.#captureSessionId = null;
    this.#transition("stopped", requestId, null);
  }

  async #shutdown(requestId: string): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#captureMayBeActive) {
      try {
        await this.#runBoundedAdapterOperation((signal) =>
          this.#adapter.abort(signal),
        );
        this.#captureMayBeActive = false;
      } catch {
        // `shutdown` is the second termination barrier and must still run.
      }
    }
    try {
      await this.#runBoundedAdapterOperation((signal) =>
        this.#adapter.shutdown(signal),
      );
      this.#captureMayBeActive = false;
    } catch {
      this.#grant = null;
      await this.#publishFailureIndicatorBestEffort();
      this.#transition("failed", requestId, "adapter_failure");
      throw new CompanionControllerError("adapter_failure");
    }

    this.#grant = null;
    try {
      await this.#indicator.publish(this.#inactiveIndicator());
    } catch {
      this.#transition("failed", requestId, "indicator_failure");
      throw new CompanionControllerError("indicator_failure");
    }
    this.#releaseLease();
    this.#closed = true;
    this.#captureSessionId = null;
    this.#transition("stopped", requestId, null);
    this.#unsubscribeAdapter();
  }

  async #handleAdapterSignal(signal: AdapterSignal): Promise<void> {
    if (this.#closed || this.#state === "failed" || this.#grant === null) {
      return;
    }
    if (signal.kind === "network_lost" || signal.kind === "device_changed") {
      await this.#terminalFailure(signal.kind, null);
      return;
    }
    if (signal.kind === "failed") {
      await this.#terminalFailure("adapter_failure", null);
      return;
    }
    if (this.#state === "recording") {
      await this.#terminalFailure("adapter_failure", null);
      return;
    }
    this.#transition(signal.kind, null, null);
  }

  async #terminalFailure(
    reasonCode: FailureCode,
    requestId: string | null,
  ): Promise<void> {
    this.#grant = null;
    this.#transition("failed", requestId, reasonCode);
    if (this.#captureMayBeActive) {
      try {
        await this.#runBoundedAdapterOperation((signal) =>
          this.#adapter.abort(signal),
        );
        this.#captureMayBeActive = false;
      } catch {
        // Capture is now uncertain. Keep both the lease and visible warning.
      }
    }
    await this.#publishFailureIndicatorBestEffort();
  }

  #requireGrant(): BackendCaptureGrant {
    if (
      this.#grant === null ||
      this.#grant.consentStatus !== "granted" ||
      this.#grant.sessionStatus !== "authorized"
    ) {
      throw new CompanionControllerError("precondition_failed");
    }
    return this.#grant;
  }

  #releaseLease(): void {
    if (this.#leaseHeld) {
      this.#lease.release(this.#leaseOwner);
      this.#leaseHeld = false;
    }
  }

  #activeIndicator(
    phase: "recording" | "failed",
  ): RecordingIndicatorSnapshot {
    if (this.#captureSessionId === null) {
      throw new CompanionControllerError("precondition_failed");
    }
    return {
      visibility: "persistent",
      visible: true,
      phase,
      captureSessionId: this.#captureSessionId,
    };
  }

  #inactiveIndicator(): RecordingIndicatorSnapshot {
    return {
      visibility: "persistent",
      visible: false,
      phase: "inactive",
      captureSessionId: null,
    };
  }

  async #publishFailureIndicatorBestEffort(): Promise<void> {
    if (this.#captureSessionId === null) {
      return;
    }
    try {
      await this.#indicator.publish(this.#activeIndicator("failed"));
    } catch {
      // The previous visible recording indicator remains the safe fallback.
    }
  }

  #transition(
    state: CompanionState,
    requestId: string | null,
    reasonCode: FailureCode | null,
  ): void {
    this.#state = state;
    this.#reasonCode = reasonCode;
    const event: ControllerStateEvent = Object.freeze({
      schemaVersion: ELECTRON_IPC_SCHEMA_VERSION,
      requestId,
      state,
      captureSessionId: this.#captureSessionId,
      reasonCode,
    });
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // The native indicator remains authoritative if a renderer is gone.
      }
    }
  }
}

function authorityFailureCode(error: unknown): FailureCode {
  if (error instanceof CaptureAuthorityError) {
    return error.code;
  }
  if (error instanceof ProtocolValidationError) {
    return "authority_changed";
  }
  return "authority_unavailable";
}
