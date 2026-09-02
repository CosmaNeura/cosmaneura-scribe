import { registerPlugin } from "@capacitor/core";

import type { IOSPCMPlugin } from "./definitions.js";

export { clearIosPcmBytes, decodeIosPcmBase64 } from "./codec.js";
export {
  IOS_PCM_EVENT_NAME,
  IOS_PCM_MAXIMUM_PACKET_BYTES,
} from "./definitions.js";
export type {
  IOSPCMPlugin,
  IosPcmAcknowledgementResult,
  IosPcmAppState,
  IosPcmConfiguration,
  IosPcmEncodedPacket,
  IosPcmErrorCode,
  IosPcmEvent,
  IosPcmInterruptionCode,
  IosPcmInterruptionEvent,
  IosPcmPacketEvent,
  IosPcmReplayResult,
  IosPcmSequenceOptions,
  IosPcmSessionOptions,
  IosPcmStopMode,
  IosPcmStopOptions,
  IosPcmStopResult,
  IosPcmTerminalCode,
  IosPcmTerminalEvent,
} from "./definitions.js";

export const IOSPCM = registerPlugin<IOSPCMPlugin>("IOSPCM");
