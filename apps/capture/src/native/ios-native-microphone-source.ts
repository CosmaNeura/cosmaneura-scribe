import { AudioCaptureError } from "../audio/errors";
import { NativePcmCaptureSource } from "./native-pcm-source";
import type { NativePcmBridge, NativePcmSink } from "./native-pcm-bridge";
import {
  IosNativeMicrophoneBridgeError,
  type IosNativeMicrophoneBridge,
  type IosNativeMicrophoneInterruptionCode,
  type IosNativeMicrophoneTerminalErrorCode,
} from "./ios-native-pcm-bridge";

/** Preserve the iOS foreground-only policy around the shared PCM lifecycle. */
export class IosNativeMicrophoneCaptureSource extends NativePcmCaptureSource {
  public constructor(bridge: IosNativeMicrophoneBridge) {
    const adapted: NativePcmBridge = {
      getAvailability: async () => {
        try { return await bridge.getAppState() === "foreground"; }
        catch (error) { throw startFailure(error); }
      },
      start: (configuration, sink) => {
        try {
          const session = bridge.start(configuration, {
            onPcmPacket: packet => sink.onPcmPacket(packet),
            onInterruption: code => interruption(sink, code),
            onError: code => terminal(sink, code),
          });
          return {
            ready: session.ready.catch((error: unknown) => { throw startFailure(error); }),
            stop: options => session.stop(options),
          };
        } catch (error) { throw startFailure(error); }
      },
    };
    super(adapted);
  }
}

function interruption(sink: NativePcmSink, code: IosNativeMicrophoneInterruptionCode): void {
  switch (code) {
    case "ios_audio_session_interrupted": sink.onInterruption("audio_session_interrupted"); break;
    case "ios_audio_route_changed": sink.onInterruption("audio_route_changed"); break;
    case "ios_capture_backgrounded": sink.onInterruption("capture_backgrounded"); break;
    default: sink.onError("protocol_error");
  }
}

function terminal(sink: NativePcmSink, code: IosNativeMicrophoneTerminalErrorCode): void {
  switch (code) {
    case "ios_microphone_permission_revoked": sink.onError("permission_revoked"); break;
    case "ios_capture_stalled": sink.onError("stalled"); break;
    case "ios_capture_failed": sink.onError("failed"); break;
    default: sink.onError("protocol_error");
  }
}

function startFailure(error: unknown): AudioCaptureError {
  if (error instanceof AudioCaptureError) return error;
  if (error instanceof IosNativeMicrophoneBridgeError) {
    switch (error.code) {
      case "ios_microphone_permission_denied":
      case "ios_microphone_permission_restricted": return new AudioCaptureError("audio_capture_permission_denied");
      case "ios_microphone_unavailable": return new AudioCaptureError("audio_capture_device_unavailable");
    }
  }
  return new AudioCaptureError("audio_capture_unavailable");
}
