import type {
  AdapterInitialState,
  AdapterSignal,
  DesktopCaptureAdapter,
} from "./capture-adapter.js";
import type { OneTimeCaptureCapability } from "./protocol.js";

export type MockAdapterOperation =
  | "initialize"
  | "refresh_permissions"
  | "start"
  | "stop"
  | "abort"
  | "shutdown";

export class MockDesktopCaptureAdapter implements DesktopCaptureAdapter {
  readonly operations: MockAdapterOperation[] = [];
  readonly #listeners = new Set<(signal: AdapterSignal) => void>();
  #initialState: AdapterInitialState;
  #initialized = false;
  #recording = false;

  constructor(initialState: AdapterInitialState = "ready") {
    this.#initialState = initialState;
  }

  initialize(signal: AbortSignal): Promise<AdapterInitialState> {
    if (signal.aborted) {
      return Promise.reject(new Error("Adapter initialization was cancelled"));
    }
    this.operations.push("initialize");
    this.#initialized = true;
    return Promise.resolve(this.#initialState);
  }

  refreshPermissions(signal: AbortSignal): Promise<AdapterInitialState> {
    this.#requireInitialized();
    if (signal.aborted) {
      return Promise.reject(new Error("Permission refresh was cancelled"));
    }
    this.operations.push("refresh_permissions");
    return Promise.resolve(this.#initialState);
  }

  start(
    capability: OneTimeCaptureCapability,
    signal: AbortSignal,
  ): Promise<void> {
    this.#requireInitialized();
    if (
      this.#recording ||
      capability.secret.length === 0 ||
      signal.aborted
    ) {
      throw new Error("Adapter is already recording");
    }
    this.operations.push("start");
    this.#recording = true;
    return Promise.resolve();
  }

  stop(signal: AbortSignal): Promise<void> {
    if (!this.#recording || signal.aborted) {
      throw new Error("Adapter cannot stop");
    }
    this.operations.push("stop");
    this.#recording = false;
    return Promise.resolve();
  }

  abort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new Error("Adapter abort was cancelled"));
    }
    this.operations.push("abort");
    this.#recording = false;
    return Promise.resolve();
  }

  shutdown(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new Error("Adapter shutdown was cancelled"));
    }
    this.operations.push("shutdown");
    this.#recording = false;
    this.#initialized = false;
    return Promise.resolve();
  }

  onSignal(listener: (signal: AdapterSignal) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setInitialState(state: AdapterInitialState): void {
    this.#initialState = state;
  }

  emit(signal: AdapterSignal): void {
    for (const listener of this.#listeners) {
      listener(signal);
    }
  }

  #requireInitialized(): void {
    if (!this.#initialized) {
      throw new Error("Adapter is not initialized");
    }
  }
}
