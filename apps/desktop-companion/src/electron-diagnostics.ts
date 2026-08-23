export const NO_PHI_DIAGNOSTICS_POLICY = Object.freeze({
  analyticsEnabled: false,
  chromiumLoggingEnabled: false,
  electronCrashReporterStarted: false,
  localElectronCrashDumpsAllowed: false,
  nodeDiagnosticReportsEnabled: false,
  remoteDebuggingEnabled: false,
  supportBundlesEnabled: false,
});

const FORBIDDEN_CHROMIUM_SWITCHES = Object.freeze([
  "enable-logging",
  "log-file",
  "log-net-log",
  "net-log-capture-mode",
  "remote-debugging-pipe",
  "remote-debugging-port",
  "trace-startup",
  "trace-startup-duration",
  "trace-startup-file",
  "v",
  "vmodule",
]);

const FORBIDDEN_PROCESS_ARGUMENTS = Object.freeze([
  "--diagnostic-dir",
  "--heapsnapshot-near-heap-limit",
  "--heapsnapshot-signal",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--report-directory",
  "--report-filename",
  "--report-on-fatalerror",
  "--report-on-signal",
  "--report-signal",
  "--report-uncaught-exception",
  "--trace-event-file-pattern",
]);

export interface ElectronCommandLineDiagnosticPort {
  hasSwitch(name: string): boolean;
}

/**
 * Enforced before Electron becomes ready. Any diagnostic surface that could
 * persist credentials, meeting metadata, audio, or transcripts aborts startup.
 * Electron crashReporter is deliberately never started: disabling upload alone
 * would still create local Crashpad reports.
 */
export function enforceNoPhiDiagnosticPolicy(
  commandLine: ElectronCommandLineDiagnosticPort,
  argv: readonly string[],
  execArgv: readonly string[],
): void {
  for (const name of FORBIDDEN_CHROMIUM_SWITCHES) {
    if (commandLine.hasSwitch(name)) {
      throw new Error("Desktop diagnostics are disabled");
    }
  }

  for (const argument of [...argv, ...execArgv]) {
    if (FORBIDDEN_PROCESS_ARGUMENTS.some((name) => isNamedArgument(argument, name))) {
      throw new Error("Desktop diagnostics are disabled");
    }
  }
}

function isNamedArgument(argument: string, name: string): boolean {
  return argument === name || argument.startsWith(`${name}=`);
}
