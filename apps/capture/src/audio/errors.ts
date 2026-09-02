export type AudioCaptureErrorCode =
  | "audio_capture_already_active"
  | "audio_capture_already_closed"
  | "audio_capture_callback_failed"
  | "audio_capture_device_unavailable"
  | "audio_capture_input_limit_exceeded"
  | "audio_capture_invalid_configuration"
  | "audio_capture_invalid_pcm"
  | "audio_capture_native_protocol_error"
  | "audio_capture_native_stop_failed"
  | "audio_capture_output_limit_exceeded"
  | "audio_capture_permission_denied"
  | "audio_capture_stale_generation"
  | "audio_capture_unavailable"
  | "audio_capture_worklet_protocol_error";

/** Fixed-code failures keep audio samples and device details out of error surfaces. */
export class AudioCaptureError extends Error {
  public constructor(public readonly code: AudioCaptureErrorCode) {
    super(code);
    this.name = "AudioCaptureError";
  }
}
