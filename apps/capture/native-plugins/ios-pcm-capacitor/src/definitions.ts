import type { PluginListenerHandle } from "@capacitor/core";

export const IOS_PCM_EVENT_NAME = "iosNativePcmEvent" as const;
export const IOS_PCM_MAXIMUM_PACKET_BYTES = 1_920_000;

export type IosPcmAppState = "foreground" | "background";
export type IosPcmStopMode = "drain" | "discard";
export type IosPcmAcknowledgementResult = "accepted" | "replayed" | "stale";
export type IosPcmReplayResult =
  | "replayed"
  | "already_acknowledged"
  | "stale"
  | "transport_failed";

export type IosPcmErrorCode =
  | "ios_capture_invalid_arguments"
  | "ios_microphone_permission_denied"
  | "ios_microphone_permission_restricted"
  | "ios_microphone_unavailable"
  | "ios_capture_not_foreground"
  | "ios_capture_start_failed"
  | "ios_capture_failed"
  | "ios_capture_stop_failed";

export type IosPcmInterruptionCode =
  | "ios_audio_session_interrupted"
  | "ios_audio_route_changed"
  | "ios_capture_backgrounded";

export type IosPcmTerminalCode =
  | "ios_microphone_permission_revoked"
  | "ios_capture_stalled"
  | "ios_capture_failed";

export interface IosPcmConfiguration {
  encoding: "pcm_s16le";
  channels: 1;
  sampleRateHz: 16000;
  targetFramesPerChunk: number;
  maximumChunks: number;
}

export interface IosPcmSessionOptions {
  sessionToken: string;
}

export interface IosPcmSequenceOptions extends IosPcmSessionOptions {
  sequenceNumber: number;
}

export interface IosPcmStopOptions extends IosPcmSessionOptions {
  mode: IosPcmStopMode;
}

export interface IosPcmEncodedPacket extends IosPcmSequenceOptions {
  /** Standard padded Base64. It is PHI-bearing until decoded and cleared. */
  pcmBase64: string;
}

export interface IosPcmPacketEvent {
  kind: "packet";
  packet: IosPcmEncodedPacket;
}

export interface IosPcmInterruptionEvent extends IosPcmSessionOptions {
  kind: "interruption";
  code: IosPcmInterruptionCode;
}

export interface IosPcmTerminalEvent extends IosPcmSessionOptions {
  kind: "terminal";
  code: IosPcmTerminalCode;
}

export type IosPcmEvent =
  | IosPcmPacketEvent
  | IosPcmInterruptionEvent
  | IosPcmTerminalEvent;

export interface IosPcmStopResult {
  /** A drain-only final partial packet. It is not acknowledged after close. */
  finalPcmPacket: IosPcmEncodedPacket | null;
}

export interface IOSPCMPlugin {
  getAppState(): Promise<{ state: IosPcmAppState }>;
  start(options: IosPcmConfiguration): Promise<{ sessionToken: string }>;
  ready(options: IosPcmSessionOptions): Promise<Record<string, never>>;
  heartbeat(options: IosPcmSessionOptions): Promise<Record<string, never>>;
  stop(options: IosPcmStopOptions): Promise<IosPcmStopResult>;
  acknowledge(
    options: IosPcmSequenceOptions,
  ): Promise<{ result: IosPcmAcknowledgementResult }>;
  replayPendingPacket(
    options: IosPcmSequenceOptions,
  ): Promise<{ result: IosPcmReplayResult }>;
  addListener(
    eventName: typeof IOS_PCM_EVENT_NAME,
    listener: (event: IosPcmEvent) => void,
  ): Promise<PluginListenerHandle>;
}
