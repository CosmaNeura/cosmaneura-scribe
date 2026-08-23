import { RECALL_DESKTOP_API_URL } from "./recall-sdk-adapter.js";

export const RECALL_NON_CAPTURE_ACCEPTANCE_PERMISSIONS = Object.freeze([
  "accessibility",
  "screen-capture",
  "microphone",
] as const);

export const RECALL_NON_CAPTURE_ACCEPTANCE_EVENTS = Object.freeze([
  "error",
  "meeting-detected",
  "permission-status",
  "permissions-granted",
  "shutdown",
] as const);

export const RECALL_NON_CAPTURE_ACCEPTANCE_INIT = Object.freeze({
  apiUrl: RECALL_DESKTOP_API_URL,
  restartOnError: false,
  acquirePermissionsOnStartup: Object.freeze([]),
});

export type RecallNonCaptureAcceptancePermission =
  (typeof RECALL_NON_CAPTURE_ACCEPTANCE_PERMISSIONS)[number];
export type RecallNonCaptureAcceptanceEvent =
  (typeof RECALL_NON_CAPTURE_ACCEPTANCE_EVENTS)[number];

export interface RecallNonCaptureAcceptancePort {
  init(options: typeof RECALL_NON_CAPTURE_ACCEPTANCE_INIT): Promise<unknown>;
  shutdown(): Promise<unknown>;
  requestPermission(
    permission: RecallNonCaptureAcceptancePermission,
  ): Promise<unknown>;
  addEventListener(
    event: RecallNonCaptureAcceptanceEvent,
    listener: (payload: unknown) => void,
  ): void;
  removeEventListener(
    event: RecallNonCaptureAcceptanceEvent,
    listener: (payload: unknown) => void,
  ): void;
}

/**
 * Creates the scripts-only acceptance surface. Recording, window identifiers,
 * uploads, dumps, generic commands, and raw event payloads are not exposed.
 */
export function createRecallNonCaptureAcceptancePort(
  candidateValue: unknown,
): RecallNonCaptureAcceptancePort {
  const module = asRecord(candidateValue);
  const candidate = isRecord(module.default) ? module.default : module;
  for (const name of [
    "init",
    "shutdown",
    "requestPermission",
    "addEventListener",
    "removeEventListener",
  ] as const) {
    if (typeof candidate[name] !== "function") {
      throw new Error("Recall acceptance module has an invalid safe surface");
    }
  }

  return Object.freeze({
    init: (options: typeof RECALL_NON_CAPTURE_ACCEPTANCE_INIT) =>
      callPromise(candidate, "init", [
        {
          apiUrl: options.apiUrl,
          restartOnError: options.restartOnError,
          acquirePermissionsOnStartup: [],
        },
      ]),
    shutdown: () => callPromise(candidate, "shutdown", []),
    requestPermission: (permission: RecallNonCaptureAcceptancePermission) =>
      callPromise(candidate, "requestPermission", [permission]),
    addEventListener: (
      event: RecallNonCaptureAcceptanceEvent,
      listener: (payload: unknown) => void,
    ) => callVoid(candidate, "addEventListener", [event, listener]),
    removeEventListener: (
      event: RecallNonCaptureAcceptanceEvent,
      listener: (payload: unknown) => void,
    ) => callVoid(candidate, "removeEventListener", [event, listener]),
  });
}

function callPromise(
  candidate: Record<string, unknown>,
  name: string,
  args: readonly unknown[],
): Promise<unknown> {
  const method = candidate[name];
  if (typeof method !== "function") {
    return Promise.reject(new Error("Recall acceptance safe method is unavailable"));
  }
  try {
    return Promise.resolve(Reflect.apply(method, candidate, args));
  } catch {
    return Promise.reject(new Error("Recall acceptance safe method failed"));
  }
}

function callVoid(
  candidate: Record<string, unknown>,
  name: string,
  args: readonly unknown[],
): void {
  const method = candidate[name];
  if (typeof method !== "function") {
    throw new Error("Recall acceptance safe method is unavailable");
  }
  Reflect.apply(method, candidate, args);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Recall acceptance module is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
