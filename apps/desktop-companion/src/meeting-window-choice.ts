import { CAPTURE_OPERATION_TIMEOUT_MS } from "./config.js";
import type { NativeMeetingWindow } from "./native-provider-presentation.js";

/** Main-only provenance; neither native identities nor this field cross IPC. */
export interface MeetingWindowChoice {
  readonly id: string;
  readonly value: NativeMeetingWindow;
  readonly selection?: "explicit" | "recommended";
}

export function sameCallWindow(a: NativeMeetingWindow, b: NativeMeetingWindow): boolean {
  return a.application === b.application && a.processID === b.processID
    && a.windowID === b.windowID && a.title === b.title;
}

/** Recognize only the visible native window title, never background tabs or
 * URLs. Chrome Meet uses a canonical code and ASCII/en/em dash separator;
 * the native prefix and optional Google Chrome suffix are the only adornments.
 * Zoom's home/settings windows are deliberately not recommendations. */
export function isRecognizedCallWindow(value: NativeMeetingWindow): boolean {
  if (value.application === "com.google.Chrome") {
    const title = value.title.replace(/^Chrome — /u, "").replace(/ [-–—] Google Chrome$/u, "");
    return /^Meet [-–—] [a-z]{3}-[a-z]{4}-[a-z]{3}$/iu.test(title);
  }
  return value.application === "us.zoom.xos"
    && /^(?:Zoom Meeting|Zoom Webinar)$/u.test(value.title.replace(/^Zoom — /u, ""));
}

export function recommendedCallWindow(choices: readonly MeetingWindowChoice[]): MeetingWindowChoice | null {
  const calls = choices.filter(row => isRecognizedCallWindow(row.value));
  return calls.length === 1 ? calls[0]! : null;
}

/** Metadata only. The native implementation has the same deadline; keep it at
 * this boundary too so cancellation/late injected replies cannot restore a
 * selection or retain a provider's Start indefinitely. */
export function readMeetingWindows(list: (signal: AbortSignal) => Promise<readonly NativeMeetingWindow[]>,
  signal: AbortSignal): Promise<readonly NativeMeetingWindow[]> {
  const deadline = new AbortController(), operationSignal = AbortSignal.any([signal, deadline.signal]);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, values?: readonly NativeMeetingWindow[]): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancelled);
      if (error !== undefined || operationSignal.aborted || values === undefined) reject(error instanceof Error ? error : unavailable());
      else resolve(values);
    };
    const cancelled = (): void => { deadline.abort(); finish(unavailable()); };
    const timer = setTimeout(cancelled, CAPTURE_OPERATION_TIMEOUT_MS);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) { cancelled(); return; }
    void Promise.resolve().then(() => {
      if (operationSignal.aborted) throw unavailable();
      return list(operationSignal);
    }).then(values => {
      if (!Array.isArray(values)) { finish(unavailable()); return; }
      const rows = values as readonly NativeMeetingWindow[];
      if (rows.length > 64 || rows.some(value => !value
        || !["com.google.Chrome", "us.zoom.xos"].includes(value.application)
        || !Number.isSafeInteger(value.processID) || value.processID < 1
        || !Number.isSafeInteger(value.windowID) || value.windowID < 1
        || typeof value.title !== "string" || !value.title || value.title.length > 512
        || [...value.title].some(c => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127))
        || new Set(rows.map(value => `${value.application}:${value.processID}:${value.windowID}`)).size !== rows.length) {
        finish(unavailable()); return;
      }
      finish(undefined, rows.map(value => Object.freeze({ ...value })));
    }, error => finish(error));
  });
}
function unavailable(): Error { return new Error("Call window selection is unavailable."); }
