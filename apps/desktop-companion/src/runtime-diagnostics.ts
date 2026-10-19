import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";

const TIMING_EVENTS = ["audio_availability_helper_check", "audio_availability_probe", "audio_permission_helper_check",
  "audio_permission_probe", "audio_capture_helper_check", "audio_packet_sink", "audio_chunk_commit", "provider_catalog", "provider_mount",
  "provider_upload_authorization", "provider_chunk_registration", "provider_chunk_receipt", "provider_lease_renewal", "provider_chunk_reservation",
  "provider_admission", "provider_review", "provider_capabilities", "provider_encryption_key",
  "provider_preparation_metadata",
  "provider_recorder_attach", "provider_recorder_prepare", "provider_consent_to_ready",
  "provider_recording_window", "provider_other_operation", "provider_source_prepare", "provider_source_authorize",
  "provider_workspace_list", "provider_workspace_open", "provider_journal_read", "provider_visit_preferences"] as const;
export type RuntimeTimingEvent = typeof TIMING_EVENTS[number];
const FAILURE_REASON_LIMITS = {
  audio_native_failure_reason: [1, 12], audio_main_failure_reason: [1, 15],
  audio_input_change_trigger: [1, 5], audio_input_change_mismatch: [0, 255],
} as const;
type FailureReasonEvent = keyof typeof FAILURE_REASON_LIMITS;
const FAILURE_REASON_EVENTS = Object.keys(FAILURE_REASON_LIMITS) as FailureReasonEvent[];
const TERMINAL_EVENTS = ["audio_stop_confirmed", "audio_permission_required", "audio_device_changed", "audio_session_locked",
  "audio_clock_discontinuity", "audio_overflow", "audio_failed", ...FAILURE_REASON_EVENTS,
  "audio_packet_invalid", "audio_chunk_commit_failed"] as const;
const EVENTS = ["host_open", "window_ready", "connect_begin", "backend_ready", "presentation_ready", "connect_ready", "connect_failed",
  "before_quit", "window_close", "renderer_gone", "renderer_navigation", "close_begin", "boundary_closed", "owner_closed", "close_failed", "quit_ready",
  "audio_start_pending", "audio_helper_spawned", "audio_ready", "audio_start_timeout",
  ...TERMINAL_EVENTS,
  "meeting_windows_ready", "meeting_windows_empty", "meeting_windows_screen_access_denied", "meeting_windows_lookup_failed",
  "meeting_windows_limit_exceeded", "meeting_windows_unavailable", "meeting_windows_protocol_failed", "meeting_windows_transport_failed",
  ...TIMING_EVENTS] as const;
export type RuntimeDiagnostic = (event: typeof EVENTS[number], durationMilliseconds?: number, reasonCode?: number) => void;
export const NO_DIAGNOSTICS: RuntimeDiagnostic = () => undefined;

/** Local bounded lifecycle metadata only. Never accepts error messages, URLs,
 * identities, request bodies or capture content. Failure cannot block cleanup. */
export function runtimeDiagnostics(directory: string): RuntimeDiagnostic {
  let remaining = 128, remainingTerminal = 32, writing = Promise.resolve();
  return (event, durationMilliseconds, reasonCode) => {
    if (!EVENTS.includes(event)) return;
    const timing = TIMING_EVENTS.includes(event as RuntimeTimingEvent);
    if (timing ? typeof durationMilliseconds !== "number" || !Number.isFinite(durationMilliseconds)
      || durationMilliseconds < 0 || durationMilliseconds > 3_600_000 : durationMilliseconds !== undefined) return;
    const failureReason = FAILURE_REASON_EVENTS.includes(event as FailureReasonEvent);
    const reasonLimits = failureReason ? FAILURE_REASON_LIMITS[event as FailureReasonEvent] : undefined;
    if (reasonLimits ? !Number.isSafeInteger(reasonCode) || reasonCode! < reasonLimits[0]
      || reasonCode! > reasonLimits[1] : reasonCode !== undefined) return;
    // Preserve a bounded terminal allowance after routine startup/upload events
    // fill their budget, so prolonged recording can still explain its stop.
    if (TERMINAL_EVENTS.includes(event as typeof TERMINAL_EVENTS[number]) ? remainingTerminal-- <= 0 : remaining-- <= 0) return;
    const line = JSON.stringify({ utc: new Date().toISOString(), pid: process.pid, event,
      ...(durationMilliseconds === undefined ? {} : { duration_ms: Math.round(durationMilliseconds * 1000) / 1000 }),
      ...(reasonCode === undefined ? {} : { reason_code: reasonCode }) }) + "\n";
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
