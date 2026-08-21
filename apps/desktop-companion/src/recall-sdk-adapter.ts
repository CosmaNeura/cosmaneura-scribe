import type {
  AdapterInitialState,
  AdapterSignal,
  DesktopCaptureAdapter,
} from "./capture-adapter.js";
import { RECALL_DESKTOP_SDK_CONFIG } from "./config.js";
import type { OneTimeCaptureCapability } from "./protocol.js";

export const RECALL_DESKTOP_API_URL = RECALL_DESKTOP_SDK_CONFIG.apiUrl;

const REQUIRED_PERMISSIONS = [
  "accessibility",
  "screen-capture",
  "microphone",
  "system-audio",
] as const;

const RECALL_EVENT_NAMES = [
  "error",
  "media-capture-status",
  "meeting-closed",
  "meeting-detected",
  "meeting-updated",
  "network-status",
  "permission-status",
  "permissions-granted",
  "recording-ended",
  "recording-started",
  "shutdown",
] as const;

export type RecallEventName = (typeof RECALL_EVENT_NAMES)[number];
export type RecallPermission = (typeof REQUIRED_PERMISSIONS)[number];

export interface RecallSdkInitOptions {
  api_url: typeof RECALL_DESKTOP_API_URL;
  restartOnError: false;
  acquirePermissionsOnStartup: [];
}

export interface RecallSdkPort {
  init(options: RecallSdkInitOptions): Promise<unknown>;
  shutdown(): Promise<unknown>;
  startRecording(config: { windowId: string; uploadToken: string }): Promise<unknown>;
  stopRecording(config: { readonly windowId: string }): Promise<unknown>;
  requestPermission(permission: RecallPermission): Promise<unknown>;
  addEventListener(
    type: RecallEventName,
    callback: (payload: unknown) => void,
  ): void;
  removeEventListener(
    type: RecallEventName,
    callback: (payload: unknown) => void,
  ): void;
}

export type NormalizedRecallEvent =
  | { readonly kind: "device_changed" }
  | { readonly kind: "failed" }
  | { readonly kind: "meeting_closed"; readonly windowId: string }
  | { readonly kind: "meeting_detected"; readonly windowId: string }
  | { readonly kind: "network_lost" }
  | { readonly kind: "permission_granted"; readonly permission: RecallPermission }
  | { readonly kind: "permission_required"; readonly permission: RecallPermission }
  | { readonly kind: "permissions_granted" }
  | { readonly kind: "recording_ended"; readonly windowId: string }
  | { readonly kind: "recording_started"; readonly windowId: string };

export class RecallDesktopCaptureAdapter implements DesktopCaptureAdapter {
  readonly #sdk: RecallSdkPort;
  readonly #listeners = new Set<(signal: AdapterSignal) => void>();
  readonly #sdkListeners = new Map<RecallEventName, (payload: unknown) => void>();
  readonly #consumedCapabilities = new Set<string>();
  readonly #grantedPermissions = new Set<RecallPermission>();
  #sdkStarted = false;
  #initialized = false;
  #permissionsGranted = false;
  #meetingWindowId: string | null = null;
  #activeWindowId: string | null = null;
  #recording = false;
  #terminationRequested = false;

  constructor(sdk: RecallSdkPort) {
    this.#sdk = sdk;
  }

  async initialize(signal: AbortSignal): Promise<AdapterInitialState> {
    if (signal.aborted || this.#activeWindowId !== null) {
      throw new Error("Recall adapter cannot initialize");
    }
    if (this.#initialized) {
      return this.#initialState();
    }
    this.#installSdkListeners();
    this.#sdkStarted = true;
    try {
      await raceWithAbort(
        this.#sdk.init({
          api_url: RECALL_DESKTOP_API_URL,
          restartOnError: RECALL_DESKTOP_SDK_CONFIG.restartOnError,
          acquirePermissionsOnStartup: [],
        }),
        signal,
        async () => this.#sdk.shutdown(),
      );
      this.#initialized = true;
      return this.#initialState();
    } catch {
      try {
        await this.#sdk.shutdown();
        this.#sdkStarted = false;
      } catch {
        // A later controller shutdown remains the second termination barrier.
      }
      this.#removeSdkListeners();
      throw new Error("Recall adapter initialization failed");
    }
  }

  async refreshPermissions(signal: AbortSignal): Promise<AdapterInitialState> {
    this.#requireInitialized();
    for (const permission of REQUIRED_PERMISSIONS) {
      await raceWithAbort(
        this.#sdk.requestPermission(permission),
        signal,
        async () => Promise.resolve(),
      );
    }
    return this.#initialState();
  }

  async start(
    capability: OneTimeCaptureCapability,
    signal: AbortSignal,
  ): Promise<void> {
    this.#requireInitialized();
    if (
      signal.aborted ||
      !this.#permissionsGranted ||
      this.#meetingWindowId === null ||
      this.#activeWindowId !== null ||
      this.#consumedCapabilities.has(capability.capabilityId) ||
      capability.secret.length === 0
    ) {
      capability.secret = "";
      throw new Error("Recall recording cannot start");
    }

    this.#consumedCapabilities.add(capability.capabilityId);
    const windowId = this.#meetingWindowId;
    this.#activeWindowId = windowId;
    this.#terminationRequested = false;
    const command = {
      windowId,
      uploadToken: capability.secret,
    };
    let startOperation: Promise<unknown>;
    try {
      startOperation = this.#sdk.startRecording(command);
    } finally {
      command.uploadToken = "";
      capability.secret = "";
    }

    await raceWithAbort(startOperation, signal, async () => {
      await this.#sdk.stopRecording({ windowId });
    });
    this.#recording = true;
  }

  async stop(signal: AbortSignal): Promise<void> {
    this.#requireInitialized();
    const windowId = this.#activeWindowId;
    if (windowId === null || signal.aborted) {
      throw new Error("Recall recording cannot stop");
    }
    this.#terminationRequested = true;
    await this.#sdk.stopRecording({ windowId });
    this.#recording = false;
    await this.#sdk.shutdown();
    this.#sdkStarted = false;
    this.#initialized = false;
    this.#removeSdkListeners();
    this.#grantedPermissions.clear();
    this.#permissionsGranted = false;
    this.#activeWindowId = null;
    this.#meetingWindowId = null;
    this.#terminationRequested = false;
  }

  async abort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new Error("Recall recording abort was cancelled");
    }
    const windowId = this.#activeWindowId;
    if (windowId === null) {
      return;
    }
    this.#terminationRequested = true;
    await this.#sdk.stopRecording({ windowId });
    this.#recording = false;
    this.#activeWindowId = null;
    this.#meetingWindowId = null;
  }

  async shutdown(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new Error("Recall adapter shutdown was cancelled");
    }
    if (this.#activeWindowId !== null) {
      this.#terminationRequested = true;
      try {
        const stopOperation = this.#sdk.stopRecording({
          windowId: this.#activeWindowId,
        });
        void stopOperation.catch(() => undefined);
      } catch {
        // SDK shutdown below is the independent termination barrier.
      }
    }
    if (this.#sdkStarted) {
      await this.#sdk.shutdown();
      this.#sdkStarted = false;
    }
    this.#activeWindowId = null;
    this.#meetingWindowId = null;
    this.#recording = false;
    this.#initialized = false;
    this.#grantedPermissions.clear();
    this.#permissionsGranted = false;
    this.#terminationRequested = false;
    this.#removeSdkListeners();
  }

  onSignal(listener: (signal: AdapterSignal) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #installSdkListeners(): void {
    if (this.#sdkListeners.size !== 0) {
      throw new Error("Recall SDK listeners are already installed");
    }
    for (const eventName of RECALL_EVENT_NAMES) {
      const listener = (payload: unknown): void => {
        const event = normalizeRecallSdkEvent(eventName, payload);
        if (event !== null) {
          this.#handleNormalizedEvent(event);
        }
      };
      this.#sdkListeners.set(eventName, listener);
      this.#sdk.addEventListener(eventName, listener);
    }
  }

  #removeSdkListeners(): void {
    for (const [eventName, listener] of this.#sdkListeners) {
      this.#sdk.removeEventListener(eventName, listener);
    }
    this.#sdkListeners.clear();
  }

  #handleNormalizedEvent(event: NormalizedRecallEvent): void {
    switch (event.kind) {
      case "permissions_granted":
        for (const permission of REQUIRED_PERMISSIONS) {
          this.#grantedPermissions.add(permission);
        }
        this.#permissionsGranted = true;
        if (this.#meetingWindowId !== null) {
          this.#emit({ kind: "ready" });
        }
        return;
      case "permission_granted":
        this.#grantedPermissions.add(event.permission);
        this.#permissionsGranted = REQUIRED_PERMISSIONS.every((permission) =>
          this.#grantedPermissions.has(permission),
        );
        if (this.#permissionsGranted && this.#meetingWindowId !== null) {
          this.#emit({ kind: "ready" });
        }
        return;
      case "permission_required":
        this.#grantedPermissions.delete(event.permission);
        this.#permissionsGranted = false;
        this.#emit({ kind: this.#recording ? "device_changed" : "permission_required" });
        return;
      case "meeting_detected":
        if (
          this.#activeWindowId !== null &&
          this.#activeWindowId !== event.windowId
        ) {
          this.#emit({ kind: "failed" });
          return;
        }
        if (
          this.#meetingWindowId !== null &&
          this.#meetingWindowId !== event.windowId
        ) {
          this.#emit({ kind: "failed" });
          return;
        }
        if (this.#activeWindowId === null) {
          this.#meetingWindowId = event.windowId;
          this.#emit({
            kind: this.#permissionsGranted ? "ready" : "meeting_detected",
          });
        }
        return;
      case "meeting_closed":
        if (event.windowId === this.#meetingWindowId) {
          this.#meetingWindowId = null;
          this.#emit({ kind: this.#recording ? "failed" : "permission_required" });
        }
        return;
      case "network_lost":
        this.#emit({ kind: "network_lost" });
        return;
      case "device_changed":
        if (this.#recording || this.#activeWindowId !== null) {
          this.#emit({ kind: "device_changed" });
        }
        return;
      case "failed":
        this.#emit({ kind: "failed" });
        return;
      case "recording_started":
        if (event.windowId === this.#activeWindowId) {
          this.#recording = true;
        }
        return;
      case "recording_ended":
        if (event.windowId === this.#activeWindowId) {
          this.#recording = false;
          if (!this.#terminationRequested) {
            this.#emit({ kind: "failed" });
          }
        }
        return;
    }
  }

  #emit(signal: AdapterSignal): void {
    for (const listener of this.#listeners) {
      try {
        listener(Object.freeze(signal));
      } catch {
        // The controller and native indicator remain authoritative.
      }
    }
  }

  #initialState(): AdapterInitialState {
    if (this.#meetingWindowId !== null && this.#permissionsGranted) {
      return "ready";
    }
    if (this.#meetingWindowId !== null) {
      return "meeting_detected";
    }
    return "permission_required";
  }

  #requireInitialized(): void {
    if (!this.#initialized) {
      throw new Error("Recall adapter is not initialized");
    }
  }
}

export function normalizeRecallSdkEvent(
  eventName: RecallEventName,
  payload: unknown,
): NormalizedRecallEvent | null {
  if (!isBoundedPayload(payload)) {
    return Object.freeze({ kind: "failed" });
  }
  switch (eventName) {
    case "permissions-granted":
      return isRecord(payload)
        ? Object.freeze({ kind: "permissions_granted" })
        : Object.freeze({ kind: "failed" });
    case "permission-status": {
      const value = isRecord(payload) ? payload : null;
      if (
        value === null ||
        !REQUIRED_PERMISSIONS.includes(value.permission as RecallPermission) ||
        typeof value.status !== "string"
      ) {
        return Object.freeze({ kind: "failed" });
      }
      const permission = value.permission as RecallPermission;
      return value.status === "granted" || value.status === "authorized"
        ? Object.freeze({ kind: "permission_granted", permission })
        : Object.freeze({ kind: "permission_required", permission });
    }
    case "meeting-detected":
    case "meeting-updated":
      return normalizeWindowEvent("meeting_detected", payload);
    case "meeting-closed":
      return normalizeWindowEvent("meeting_closed", payload);
    case "recording-started":
      return normalizeWindowEvent("recording_started", payload);
    case "recording-ended":
      return normalizeWindowEvent("recording_ended", payload);
    case "network-status": {
      const value = isRecord(payload) ? payload : null;
      if (value?.status === "disconnected") {
        return Object.freeze({ kind: "network_lost" });
      }
      return value?.status === "reconnected"
        ? null
        : Object.freeze({ kind: "failed" });
    }
    case "media-capture-status": {
      const value = isRecord(payload) ? payload : null;
      if (value?.type === "video" && typeof value.capturing === "boolean") {
        return null;
      }
      if (value?.type === "audio" && value.capturing === false) {
        return Object.freeze({ kind: "device_changed" });
      }
      return value?.capturing === true
        ? null
        : Object.freeze({ kind: "failed" });
    }
    case "error":
    case "shutdown":
      return Object.freeze({ kind: "failed" });
  }
}

function normalizeWindowEvent(
  kind:
    | "meeting_closed"
    | "meeting_detected"
    | "recording_ended"
    | "recording_started",
  payload: unknown,
): NormalizedRecallEvent {
  const value = isRecord(payload) ? payload : null;
  const window = value !== null && isRecord(value.window) ? value.window : null;
  const windowId = window?.id;
  if (
    typeof windowId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(windowId)
  ) {
    return Object.freeze({ kind: "failed" });
  }
  return Object.freeze({ kind, windowId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedPayload(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= 64 * 1024
    );
  } catch {
    return false;
  }
}

async function raceWithAbort<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
  onAbort: () => Promise<unknown>,
): Promise<Result> {
  if (signal.aborted) {
    await onAbort();
    throw new Error("Recall SDK operation was cancelled");
  }
  let abortListener: (() => void) | undefined;
  let abortWork: Promise<unknown> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      abortWork = onAbort();
      void abortWork.then(
        () => reject(new Error("Recall SDK operation was cancelled")),
        () => reject(new Error("Recall SDK cancellation failed")),
      );
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const result = await Promise.race([operation, aborted]);
    if (signal.aborted) {
      await (abortWork ?? onAbort());
      throw new Error("Recall SDK operation was cancelled");
    }
    return result;
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}
