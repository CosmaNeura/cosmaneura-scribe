import { AudioCaptureError } from "../audio/errors";
import type { CaptureSourceWindow } from "../capture/source";

/** Metadata validation is not authority. The native receiver separately enforces
 * both clocks and the owning flow binds these values to durable Core receipts. */
export function captureSourceWindow(value: CaptureSourceWindow, maximumChunks: number,
  previous?: CaptureSourceWindow): CaptureSourceWindow {
  const keys = "expiresAtMilliseconds,generation,hardMaximumChunks,maximumChunks,runId";
  if (!value || Object.keys(value).sort().join(",") !== keys
    || typeof value.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.runId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !Number.isSafeInteger(value.expiresAtMilliseconds) || value.expiresAtMilliseconds <= Date.now()
    || value.expiresAtMilliseconds - Date.now() > 905_000
    || !Number.isSafeInteger(value.maximumChunks) || value.maximumChunks !== maximumChunks || maximumChunks < 1
    || !Number.isSafeInteger(value.hardMaximumChunks) || value.hardMaximumChunks < maximumChunks
    || value.hardMaximumChunks > 2048) throw failure();
  if (previous) {
    if (previous.expiresAtMilliseconds <= Date.now() || value.runId !== previous.runId
      || value.hardMaximumChunks !== previous.hardMaximumChunks || value.maximumChunks < previous.maximumChunks) throw failure();
    const duplicate = value.generation === previous.generation && value.expiresAtMilliseconds === previous.expiresAtMilliseconds
      && value.maximumChunks === previous.maximumChunks;
    if (!duplicate && (value.generation !== previous.generation + 1
      || value.expiresAtMilliseconds <= previous.expiresAtMilliseconds)) throw failure();
  } else if (value.generation !== 1) throw failure();
  return Object.freeze({ ...value });
}
function failure(): AudioCaptureError { return new AudioCaptureError("audio_capture_native_protocol_error"); }
