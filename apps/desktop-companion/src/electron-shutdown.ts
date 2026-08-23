const ORDINARY_SHUTDOWN_REQUEST_ID = "application-shutdown";
const EMERGENCY_SHUTDOWN_REQUEST_ID = "emergency-stop-and-quit";
const DEFAULT_EMERGENCY_FORCE_EXIT_MS = 20_000;

export interface TrustedDesktopShutdownPort {
  shutdownFromMain(requestId: string): Promise<unknown>;
  dispose(): void;
}

export interface ElectronShutdownApplicationPort {
  quit(): void;
  exit(code: number): void;
}

export interface ElectronBeforeQuitEventPort {
  preventDefault(): void;
}

export type ElectronShutdownTimerHandle = number | object;

export interface ElectronShutdownTimerPort {
  set(callback: () => void, delayMs: number): ElectronShutdownTimerHandle;
  clear(timer: ElectronShutdownTimerHandle): void;
}

const GLOBAL_TIMERS: ElectronShutdownTimerPort = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Owns the only application-exit path after bootstrap. Normal quit and the
 * native emergency action both enter the trusted controller shutdown boundary.
 * Emergency shutdown adds a process-level deadline so a wedged SDK cannot keep
 * an uncertain capture process alive indefinitely.
 */
export class ElectronShutdownCoordinator {
  readonly #boundary: TrustedDesktopShutdownPort;
  readonly #application: ElectronShutdownApplicationPort;
  readonly #timers: ElectronShutdownTimerPort;
  readonly #emergencyForceExitMs: number;
  #shutdown: Promise<void> | null = null;
  #emergencyTimer: ElectronShutdownTimerHandle | null = null;
  #allowQuit = false;
  #disposed = false;
  #forceExitStarted = false;

  constructor(options: {
    readonly boundary: TrustedDesktopShutdownPort;
    readonly application: ElectronShutdownApplicationPort;
    readonly timers?: ElectronShutdownTimerPort;
    readonly emergencyForceExitMs?: number;
  }) {
    this.#boundary = options.boundary;
    this.#application = options.application;
    this.#timers = options.timers ?? GLOBAL_TIMERS;
    this.#emergencyForceExitMs =
      options.emergencyForceExitMs ?? DEFAULT_EMERGENCY_FORCE_EXIT_MS;
    if (!Number.isSafeInteger(this.#emergencyForceExitMs) || this.#emergencyForceExitMs <= 0) {
      throw new Error("Invalid emergency shutdown deadline");
    }
  }

  handleBeforeQuit(event: ElectronBeforeQuitEventPort): void {
    if (this.#allowQuit) {
      return;
    }
    event.preventDefault();
    this.#begin(ORDINARY_SHUTDOWN_REQUEST_ID);
  }

  requestEmergencyStopAndQuit(): void {
    this.#armEmergencyForceExit();
    this.#begin(EMERGENCY_SHUTDOWN_REQUEST_ID);
  }

  isShutdownStarted(): boolean {
    return this.#shutdown !== null;
  }

  #begin(requestId: string): void {
    if (this.#shutdown !== null) {
      return;
    }
    this.#shutdown = this.#completeTrustedShutdown(requestId);
  }

  async #completeTrustedShutdown(requestId: string): Promise<void> {
    try {
      await this.#boundary.shutdownFromMain(requestId);
    } catch {
      // Process termination is the final barrier when graceful shutdown fails.
    } finally {
      this.#clearEmergencyForceExit();
      this.#disposeBoundary();
      if (!this.#forceExitStarted) {
        this.#allowQuit = true;
        this.#application.quit();
      }
    }
  }

  #armEmergencyForceExit(): void {
    if (this.#emergencyTimer !== null || this.#allowQuit) {
      return;
    }
    this.#emergencyTimer = this.#timers.set(() => {
      if (this.#forceExitStarted) {
        return;
      }
      this.#forceExitStarted = true;
      this.#emergencyTimer = null;
      this.#disposeBoundary();
      this.#application.exit(1);
    }, this.#emergencyForceExitMs);
  }

  #clearEmergencyForceExit(): void {
    if (this.#emergencyTimer === null) {
      return;
    }
    this.#timers.clear(this.#emergencyTimer);
    this.#emergencyTimer = null;
  }

  #disposeBoundary(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    try {
      this.#boundary.dispose();
    } catch {
      // Disposal cannot prevent the final process-termination barrier.
    }
  }
}
