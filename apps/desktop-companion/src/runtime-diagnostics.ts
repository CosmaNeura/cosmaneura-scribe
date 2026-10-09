import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";

const TIMING_EVENTS = ["audio_availability_helper_check", "audio_availability_probe", "audio_permission_helper_check",
  "audio_permission_probe", "audio_capture_helper_check", "provider_catalog", "provider_mount",
  "provider_admission", "provider_review", "provider_capabilities", "provider_encryption_key",
  "provider_preparation_metadata",
  "provider_recorder_attach", "provider_recorder_prepare", "provider_consent_to_ready",
  "provider_recording_window", "provider_other_operation", "provider_source_prepare", "provider_source_authorize",
  "provider_workspace_list", "provider_workspace_open", "provider_journal_read", "provider_visit_preferences"] as const;
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
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 65_536) return;
        if (info.size + Buffer.byteLength(line) > 65_536) {
          // The single-instance host serializes its writes. Retain recent complete
          // records so a full log cannot silently hide every subsequent startup.
          // Reuse the checked descriptor; never follow a replacement pathname.
          const tail = Buffer.alloc(Math.min(info.size, 32_768));
          const { bytesRead } = await file.read(tail, 0, tail.length, info.size - tail.length);
          const end = tail.lastIndexOf(10, bytesRead - 1);
          const start = info.size > tail.length ? tail.indexOf(10) + 1 : 0;
          const retained = end >= start ? tail.subarray(start, end + 1) : Buffer.alloc(0);
          await file.truncate(0);
          if (retained.length) await file.writeFile(retained);
        }
        await file.writeFile(line);
      } finally { await file.close(); }
    }).catch(() => undefined);
  };
}
