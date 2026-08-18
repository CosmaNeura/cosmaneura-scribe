import { base64UrlDecode, base64UrlEncode } from "@cosmaneura-scribe/capture-protocol";

import { QueueInvariantError } from "../queue/errors";
import { assertSafeCaptureRecord, cloneCaptureRecord } from "../queue/records";
import type { CaptureChunkRecord } from "../queue/types";

export function encodeCaptureRecord(record: CaptureChunkRecord): string {
  const safe = cloneCaptureRecord(record);
  if (
    safe.state === "encrypted" ||
    safe.state === "uploading" ||
    safe.state === "uploaded" ||
    safe.state === "registered"
  ) {
    return JSON.stringify({
      ...safe,
      envelope: base64UrlEncode(safe.envelope),
    });
  }
  return JSON.stringify(safe);
}

export function decodeCaptureRecord(encoded: string): CaptureChunkRecord {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new QueueInvariantError("invalid_stored_record");
  }
  if (!isRecord(value) || typeof value.state !== "string") {
    throw new QueueInvariantError("invalid_stored_record");
  }

  let candidate: unknown = value;
  if (
    value.state === "encrypted" ||
    value.state === "uploading" ||
    value.state === "uploaded" ||
    value.state === "registered"
  ) {
    if (typeof value.envelope !== "string") {
      throw new QueueInvariantError("invalid_stored_record");
    }
    try {
      candidate = { ...value, envelope: base64UrlDecode(value.envelope) };
    } catch {
      throw new QueueInvariantError("invalid_stored_record");
    }
  }

  assertSafeCaptureRecord(candidate as CaptureChunkRecord);
  return cloneCaptureRecord(candidate as CaptureChunkRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
