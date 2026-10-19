import type { ProviderRecorderController, ProviderRecorderSnapshot } from "../provider-binding";

export const MAX_RECORD_READY_MILLISECONDS = 3_600_000;
export type RecordReadyDiagnostic = (durationMilliseconds: number) => void;
export interface RecordReadyTiming { confirm(snapshot: ProviderRecorderSnapshot): void; cancel(): void }

/** One explicit action, one renderer monotonic clock. No identities or content
 * enter the diagnostic. A queued action retains this original start time. */
export function beginRecordReadyTiming(report?: RecordReadyDiagnostic,
  suppliedClock?: Pick<Performance, "now">): RecordReadyTiming {
  let start: number | undefined, finished = false;
  let clock: Pick<Performance, "now"> | undefined;
  try { clock = suppliedClock ?? globalThis.performance; start = clock?.now(); } catch { /* Observation cannot affect Record. */ }
  return {
    cancel: () => { finished = true; },
    confirm: snapshot => {
      if (finished) return;
      finished = true;
      try {
        if (start === undefined || !Number.isFinite(start) || !nativeRecordingConfirmed(snapshot)) return;
        if (!clock) return;
        const duration = clock.now() - start;
        if (!validRecordReadyDuration(duration)) return;
        report?.(Math.round(duration * 1000) / 1000);
      } catch { /* Diagnostic failure never changes capture or cleanup. */ }
    },
  };
}

export function validRecordReadyDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && value <= MAX_RECORD_READY_MILLISECONDS;
}

export function nativeRecordingConfirmed(snapshot: ProviderRecorderSnapshot): boolean {
  return snapshot.state === "recording"
    && (snapshot.native?.phase === "recording" || snapshot.desktop?.phase === "recording");
}

/** Await the actual bound controller command. Cancel-resolved and failed starts
 * are not successes. Existing authorization/start order and failures are kept. */
export async function startWithRecordReadyTiming(controller: ProviderRecorderController,
  timing: RecordReadyTiming | undefined, current: () => boolean): Promise<void> {
  let first = false;
  try {
    const initial = controller.snapshot;
    first = initial.state === "ready" && initial.recordedChunks === 0 && initial.elapsedSeconds === 0
      && (initial.native?.phase === "ready" || initial.desktop?.phase === "ready"
        && initial.desktop.coverage === "not_started");
  } catch { /* An unavailable diagnostic snapshot cannot prevent Start. */ }
  try {
    await controller.startRecording();
    try { if (first && current()) timing?.confirm(controller.snapshot); }
    catch { /* An unavailable diagnostic snapshot cannot change Start. */ }
  } finally { timing?.cancel(); }
}
