import { IOS_PCM_MAXIMUM_PACKET_BYTES } from "./definitions.js";

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Decode one bounded packet into a full-span, exclusively owned buffer. */
export function decodeIosPcmBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const maximumEncodedLength = Math.ceil(IOS_PCM_MAXIMUM_PACKET_BYTES / 3) * 4;
  if (
    encoded.length === 0 ||
    encoded.length > maximumEncodedLength ||
    !CANONICAL_BASE64.test(encoded)
  ) {
    throw new Error("ios_capture_invalid_arguments");
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("ios_capture_invalid_arguments");
  }
  if (
    binary.length === 0 ||
    binary.length > IOS_PCM_MAXIMUM_PACKET_BYTES ||
    binary.length % 2 !== 0
  ) {
    throw new Error("ios_capture_invalid_arguments");
  }
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Clear a packet only when the view owns its complete ArrayBuffer. */
export function clearIosPcmBytes(bytes: Uint8Array<ArrayBuffer>): void {
  if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
    throw new Error("ios_capture_invalid_arguments");
  }
  bytes.fill(0);
}
