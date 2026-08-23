import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  enforceNoPhiDiagnosticPolicy,
  NO_PHI_DIAGNOSTICS_POLICY,
} from "./electron-diagnostics.js";

describe("Electron no-PHI diagnostics policy", () => {
  it("keeps every application-controlled diagnostic surface disabled", () => {
    expect(NO_PHI_DIAGNOSTICS_POLICY).toEqual({
      analyticsEnabled: false,
      chromiumLoggingEnabled: false,
      electronCrashReporterStarted: false,
      localElectronCrashDumpsAllowed: false,
      nodeDiagnosticReportsEnabled: false,
      remoteDebuggingEnabled: false,
      supportBundlesEnabled: false,
    });
  });

  it.each([
    "enable-logging",
    "log-file",
    "log-net-log",
    "remote-debugging-pipe",
    "remote-debugging-port",
    "trace-startup",
  ])("rejects the Chromium %s switch", (activeSwitch) => {
    expect(() =>
      enforceNoPhiDiagnosticPolicy(
        { hasSwitch: (name) => name === activeSwitch },
        ["/synthetic/Cosmas"],
        [],
      ),
    ).toThrow("Desktop diagnostics are disabled");
  });

  it.each([
    "--inspect=9229",
    "--inspect-brk",
    "--diagnostic-dir=/synthetic/reports",
    "--report-on-fatalerror",
    "--heapsnapshot-signal=SIGUSR2",
  ])("rejects the Node diagnostic argument %s", (argument) => {
    expect(() =>
      enforceNoPhiDiagnosticPolicy(
        { hasSwitch: () => false },
        ["/synthetic/Cosmas"],
        [argument],
      ),
    ).toThrow("Desktop diagnostics are disabled");
  });

  it("allows ordinary executable and custom-protocol arguments", () => {
    expect(() =>
      enforceNoPhiDiagnosticPolicy(
        { hasSwitch: () => false },
        [
          "/synthetic/Cosmas",
          "cosmaneura-capture://callback?code=synthetic&state=synthetic",
        ],
        [],
      ),
    ).not.toThrow();
  });

  it("proves the bootstrap neither imports nor starts crashReporter", async () => {
    const source = await readFile(new URL("./main-entry.ts", import.meta.url), "utf8");
    expect(source).toContain("enforceNoPhiDiagnosticPolicy");
    expect(source).not.toMatch(/\bcrashReporter\b/);
    expect(source).not.toContain("enable-logging");
  });
});
