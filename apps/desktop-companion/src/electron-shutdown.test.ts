import { describe, expect, it, vi } from "vitest";

import {
  ElectronShutdownCoordinator,
  type ElectronShutdownTimerPort,
} from "./electron-shutdown.js";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Electron trusted shutdown coordinator", () => {
  it("routes ordinary quit through trusted shutdown exactly once", async () => {
    const pending = deferred();
    const shutdownFromMain = vi.fn(() => pending.promise);
    const dispose = vi.fn();
    const quit = vi.fn();
    const coordinator = new ElectronShutdownCoordinator({
      boundary: { shutdownFromMain, dispose },
      application: { quit, exit: vi.fn() },
    });
    const preventDefault = vi.fn();

    coordinator.handleBeforeQuit({ preventDefault });
    coordinator.handleBeforeQuit({ preventDefault });
    expect(coordinator.isShutdownStarted()).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(shutdownFromMain).toHaveBeenCalledOnce();
    expect(shutdownFromMain).toHaveBeenCalledWith("application-shutdown");
    expect(quit).not.toHaveBeenCalled();

    pending.resolve();
    await pending.promise;
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledOnce();

    coordinator.handleBeforeQuit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("uses the same trusted boundary for the native emergency action", async () => {
    const shutdownFromMain = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const quit = vi.fn();
    const exit = vi.fn();
    const cleared: Array<number | object> = [];
    const timer = Object.freeze({ id: "synthetic-emergency-timer" });
    const setTimer = vi.fn(() => timer);
    const timers: ElectronShutdownTimerPort = {
      set: setTimer,
      clear: (value) => void cleared.push(value),
    };
    const coordinator = new ElectronShutdownCoordinator({
      boundary: { shutdownFromMain, dispose },
      application: { quit, exit },
      timers,
      emergencyForceExitMs: 1_000,
    });

    coordinator.requestEmergencyStopAndQuit();
    coordinator.requestEmergencyStopAndQuit();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(shutdownFromMain).toHaveBeenCalledOnce();
    expect(shutdownFromMain).toHaveBeenCalledWith("emergency-stop-and-quit");
    expect(setTimer).toHaveBeenCalledOnce();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(cleared).toEqual([timer]);
    expect(exit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("forces process termination if trusted emergency shutdown wedges", () => {
    const pending = deferred();
    let emergencyDeadline = (): void => undefined;
    const dispose = vi.fn();
    const exit = vi.fn();
    const coordinator = new ElectronShutdownCoordinator({
      boundary: { shutdownFromMain: () => pending.promise, dispose },
      application: { quit: vi.fn(), exit },
      timers: {
        set: (callback) => {
          emergencyDeadline = callback;
          return Object.freeze({ id: "synthetic-emergency-timer" });
        },
        clear: vi.fn(),
      },
      emergencyForceExitMs: 1_000,
    });

    coordinator.requestEmergencyStopAndQuit();
    emergencyDeadline();
    emergencyDeadline();

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("adds the emergency deadline to an ordinary shutdown already in flight", () => {
    const pending = deferred();
    const set = vi.fn(() => Object.freeze({ id: "synthetic-timer" }));
    const coordinator = new ElectronShutdownCoordinator({
      boundary: { shutdownFromMain: () => pending.promise, dispose: vi.fn() },
      application: { quit: vi.fn(), exit: vi.fn() },
      timers: { set, clear: vi.fn() },
    });

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    coordinator.requestEmergencyStopAndQuit();
    expect(set).toHaveBeenCalledOnce();
  });

  it("still exits when graceful trusted shutdown rejects", async () => {
    const quit = vi.fn();
    const coordinator = new ElectronShutdownCoordinator({
      boundary: {
        shutdownFromMain: () => Promise.reject(new Error("synthetic failure")),
        dispose: vi.fn(),
      },
      application: { quit, exit: vi.fn() },
    });

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });
});
