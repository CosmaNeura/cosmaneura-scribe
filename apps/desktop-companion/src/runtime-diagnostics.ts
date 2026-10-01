import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";

const TIMING_EVENTS = ["audio_availability_helper_check", "audio_availability_probe", "audio_permission_helper_check",
  "audio_permission_probe", "audio_capture_helper_check"] as const;
export type RuntimeTimingEvent = typeof TIMING_EVENTS[number];
const EVENTS = ["host_open", "window_ready", "connect_begin", "backend_ready", "presentation_ready", "connect_ready", "connect_failed",
  "before_quit", "window_close", "renderer_gone", "renderer_navigation", "close_begin", "boundary_closed", "owner_closed", "close_failed", "quit_ready",
  "audio_start_pending", "audio_helper_spawned", "audio_ready", "audio_start_timeout", "audio_stop_confirmed",
  "audio_permission_required", "audio_device_changed", "audio_session_locked", "audio_clock_discontinuity", "audio_overflow", "audio_failed",
  ...TIMING_EVENTS] as const;
export type RuntimeDiagnostic = (event: typeof EVENTS[number], durationMilliseconds?: number) => void;
export const NO_DIAGNOSTICS: RuntimeDiagnostic = () => undefined;

/** Local bounded lifecycle metadata only. Never accepts error messages, URLs,
 * identities, request bodies or capture content. Failure cannot block cleanup. */
export function runtimeDiagnostics(directory: string): RuntimeDiagnostic {
  let remaining = 128, writing = Promise.resolve();
  return (event, durationMilliseconds) => {
    if (!EVENTS.includes(event)) return;
    const timing = TIMING_EVENTS.includes(event as RuntimeTimingEvent);
    if (timing ? typeof durationMilliseconds !== "number" || !Number.isFinite(durationMilliseconds)
      || durationMilliseconds < 0 || durationMilliseconds > 3_600_000 : durationMilliseconds !== undefined) return;
    if (remaining-- <= 0) return;
    const line = JSON.stringify({ utc: new Date().toISOString(), pid: process.pid, event,
      ...(durationMilliseconds === undefined ? {} : { duration_ms: Math.round(durationMilliseconds * 1000) / 1000 }) }) + "\n";
    writing = writing.then(async () => {
      if (await realpath(directory) !== directory) return;
      const file = await open(join(directory, "runtime-diagnostics-v1.jsonl"),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size + Buffer.byteLength(line) > 65_536) return;
        await file.writeFile(line);
      } finally { await file.close(); }
    }).catch(() => undefined);
  };
}
