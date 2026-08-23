import { createRequire } from "node:module";

import {
  createRecallNonCaptureAcceptancePort,
  RECALL_NON_CAPTURE_ACCEPTANCE_EVENTS,
  RECALL_NON_CAPTURE_ACCEPTANCE_INIT,
  RECALL_NON_CAPTURE_ACCEPTANCE_PERMISSIONS,
} from "../dist/recall-native-acceptance.js";
import { DESKTOP_RELEASE_MANIFEST } from "../dist/config.js";
import { enforceNoPhiDiagnosticPolicy } from "../dist/electron-diagnostics.js";
import { verifyRecallSdkRuntime } from "../dist/recall-sdk-loader.js";

const APPROVAL_ARGUMENT = "--approved-deidentified-noncapture";
const OPERATION_TIMEOUT_MS = 120_000;
const DETECTION_TIMEOUT_MS = 5 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const runtimeRequire = createRequire(
  new URL("../vendor-runtime/package.json", import.meta.url),
);
const { app } = runtimeRequire("electron");

let acceptancePort = null;
let sdkProcessMayExist = false;
let shuttingDown = false;
let exitCode = 1;

enforceNoPhiDiagnosticPolicy(app.commandLine, process.argv, process.execArgv);
if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  process.argv.at(-1) !== APPROVAL_ARGUMENT ||
  DESKTOP_RELEASE_MANIFEST.captureEnabled !== false ||
  DESKTOP_RELEASE_MANIFEST.clinicalReleaseApproved !== false
) {
  process.stderr.write("NATIVE_ACCEPTANCE_REJECTED\n");
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  process.stderr.write("NATIVE_ACCEPTANCE_DUPLICATE_REJECTED\n");
  app.exit(1);
} else {
  process.once("SIGINT", () => void finish(130));
  process.once("SIGTERM", () => void finish(143));
  void app.whenReady().then(run).catch(() => finish(1));
}

async function run() {
  app.setName("Cosmas Native Acceptance");
  let failureStage = "VERIFY";
  process.stdout.write("NATIVE_ACCEPTANCE_VERIFYING\n");
  const listeners = new Map();

  try {
    const evidence = await withTimeout(
      verifyRecallSdkRuntime(),
      OPERATION_TIMEOUT_MS,
    );
    if (evidence.clinicalReleaseApproved !== false) {
      throw new Error("Native acceptance requires disabled clinical release");
    }

    failureStage = "LOAD";
    const loaded = runtimeRequire("@recallai/desktop-sdk");
    acceptancePort = createRecallNonCaptureAcceptancePort(loaded);
    const meetingDetected = deferred();
    const nativeError = deferred();
    for (const eventName of RECALL_NON_CAPTURE_ACCEPTANCE_EVENTS) {
      const listener = () => {
        switch (eventName) {
          case "meeting-detected":
            process.stdout.write("NATIVE_ACCEPTANCE_MEETING_DETECTED\n");
            meetingDetected.resolve("detected");
            return;
          case "permission-status":
            process.stdout.write("NATIVE_ACCEPTANCE_PERMISSION_EVENT\n");
            return;
          case "permissions-granted":
            process.stdout.write("NATIVE_ACCEPTANCE_ALL_PERMISSIONS_EVENT\n");
            return;
          case "error":
            process.stderr.write("NATIVE_ACCEPTANCE_NATIVE_ERROR\n");
            nativeError.resolve("error");
            return;
          case "shutdown":
            process.stdout.write("NATIVE_ACCEPTANCE_SHUTDOWN_EVENT\n");
            sdkProcessMayExist = false;
            return;
        }
      };
      listeners.set(eventName, listener);
      acceptancePort.addEventListener(eventName, listener);
    }

    failureStage = "INITIALIZE";
    sdkProcessMayExist = true;
    await withTimeout(
      acceptancePort.init(RECALL_NON_CAPTURE_ACCEPTANCE_INIT),
      OPERATION_TIMEOUT_MS,
    );
    process.stdout.write("NATIVE_ACCEPTANCE_INITIALIZED\n");

    failureStage = "PERMISSION";
    for (const permission of RECALL_NON_CAPTURE_ACCEPTANCE_PERMISSIONS) {
      await withTimeout(
        acceptancePort.requestPermission(permission),
        OPERATION_TIMEOUT_MS,
      );
      process.stdout.write("NATIVE_ACCEPTANCE_PERMISSION_REQUEST_COMPLETED\n");
    }

    failureStage = "DETECTION";
    process.stdout.write("NATIVE_ACCEPTANCE_OPEN_SYNTHETIC_MEETING\n");
    const result = await withTimeout(
      Promise.race([meetingDetected.promise, nativeError.promise]),
      DETECTION_TIMEOUT_MS,
    );
    exitCode = result === "detected" ? 0 : 2;
  } catch (error) {
    process.stderr.write(
      `NATIVE_ACCEPTANCE_${failureStage}_${classifyFailure(error)}\n`,
    );
    exitCode = 4;
  } finally {
    for (const [eventName, listener] of listeners) {
      acceptancePort.removeEventListener(eventName, listener);
    }
    await finish(exitCode);
  }
}

function classifyFailure(error) {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (message.includes("ENOENT") || message.includes("not found")) {
    return "NOT_FOUND";
  }
  if (message.includes("EACCES") || message.includes("EPERM")) {
    return "PERMISSION_DENIED";
  }
  if (message.includes("Process exited")) {
    return "EARLY_EXIT";
  }
  if (normalized.includes("process error") || normalized.includes("server process")) {
    return "PROCESS_ERROR";
  }
  if (
    normalized.includes("invalid api url") ||
    normalized.includes("failed to create url") ||
    normalized.includes("invalid apiurl")
  ) {
    return "API_URL_REJECTED";
  }
  if (
    normalized.includes("401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("api key")
  ) {
    return "ACCOUNT_AUTHENTICATION_REJECTED";
  }
  if (
    normalized.includes("403") ||
    normalized.includes("forbidden") ||
    normalized.includes("entitlement") ||
    normalized.includes("not enabled") ||
    normalized.includes("plan does not")
  ) {
    return "WORKSPACE_ENTITLEMENT_REJECTED";
  }
  if (normalized.includes("404") || normalized.includes("not found")) {
    return "ENDPOINT_NOT_FOUND";
  }
  if (
    normalized.includes("certificate") ||
    normalized.includes("ssl") ||
    normalized.includes("tls")
  ) {
    return "TLS_REJECTED";
  }
  if (
    normalized.includes("dns") ||
    normalized.includes("enotfound") ||
    normalized.includes("name resolution")
  ) {
    return "DNS_REJECTED";
  }
  if (
    normalized.includes("econn") ||
    normalized.includes("connection refused") ||
    normalized.includes("connection reset")
  ) {
    return "CONNECTION_REJECTED";
  }
  if (normalized.includes("config") || normalized.includes("json")) {
    return "CONFIGURATION_REJECTED";
  }
  if (
    normalized.includes("network") ||
    normalized.includes("connect") ||
    normalized.includes("certificate") ||
    normalized.includes("api")
  ) {
    return "NETWORK_REJECTED";
  }
  if (
    normalized.includes("bundle") ||
    normalized.includes("exe_name") ||
    normalized.includes("identity")
  ) {
    return "HOST_IDENTITY_REJECTED";
  }
  if (normalized.includes("permission") || normalized.includes("tcc")) {
    return "OS_PERMISSION_REJECTED";
  }
  if (
    normalized.includes("command") ||
    normalized.includes("response") ||
    normalized.includes("protocol")
  ) {
    return "PROTOCOL_REJECTED";
  }
  if (message.includes("timed out")) {
    return "TIMEOUT";
  }
  return "FAILED";
}

async function finish(requestedExitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  exitCode = requestedExitCode;
  if (acceptancePort !== null && sdkProcessMayExist) {
    try {
      await withTimeout(acceptancePort.shutdown(), SHUTDOWN_TIMEOUT_MS);
      sdkProcessMayExist = false;
      process.stdout.write("NATIVE_ACCEPTANCE_SHUTDOWN_CONFIRMED\n");
    } catch {
      process.stderr.write("NATIVE_ACCEPTANCE_SHUTDOWN_UNCERTAIN\n");
      exitCode = 3;
    }
  }
  app.exit(exitCode);
}

function deferred() {
  let resolve = () => undefined;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Native acceptance operation timed out")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
