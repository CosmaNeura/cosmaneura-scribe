import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import {
  base64UrlDecode,
  base64UrlEncode,
} from "@cosmaneura-scribe/capture-protocol";

import { QueueInvariantError } from "../queue/errors";
import { assertSafeCaptureRecord } from "../queue/records";
import type {
  CaptureChunkRecord,
  CaptureQueueStorage,
  ReservedChunkRecord,
} from "../queue/types";
import { decodeCaptureRecord, encodeCaptureRecord } from "./record-codec";

const ALREADY_EXISTS = "SECURE_QUEUE_ALREADY_EXISTS";
const REVISION_CONFLICT = "SECURE_QUEUE_REVISION_CONFLICT";
const NOT_FOUND = "SECURE_QUEUE_NOT_FOUND";

/**
 * Maps the durable queue contract onto the custom Capacitor secure-queue
 * plugin. Native revisions remain opaque strings; JS record revisions are
 * separately verified before the plugin's atomic compare-and-swap.
 */
export class NativePluginQueueStorage implements CaptureQueueStorage {
  readonly #plugin: SecureQueuePlugin;

  constructor(plugin: SecureQueuePlugin) {
    this.#plugin = plugin;
  }

  async create(record: ReservedChunkRecord): Promise<boolean> {
    assertSafeCaptureRecord(record);
    try {
      const result = await this.#plugin.create(toNativeRecord(record));
      assertNativeRevision(result.revision);
      return true;
    } catch (error) {
      if (hasPluginCode(error, ALREADY_EXISTS)) return false;
      throw error;
    }
  }

  async get(objectId: string): Promise<CaptureChunkRecord | null> {
    try {
      const value = await this.#plugin.get({ key: objectId });
      return fromNativeRecord(objectId, value.key, value.data, value.revision);
    } catch (error) {
      if (hasPluginCode(error, NOT_FOUND)) return null;
      throw error;
    }
  }

  async list(): Promise<readonly CaptureChunkRecord[]> {
    const result = await this.#plugin.list();
    return Promise.all(
      // Review recovery shares native encryption, but is never an audio record.
      result.keys.filter((key) => !key.startsWith("creator-review-v1:")
        && !key.startsWith("provider-workspace-v1:")).map(async (objectId) => {
        const value = await this.#plugin.get({ key: objectId });
        return fromNativeRecord(objectId, value.key, value.data, value.revision);
      }),
    );
  }

  async compareAndSwap(
    objectId: string,
    expectedRevision: number,
    replacement: CaptureChunkRecord,
  ): Promise<boolean> {
    assertSafeCaptureRecord(replacement);
    if (
      replacement.reservation.objectId !== objectId ||
      replacement.revision !== expectedRevision + 1
    ) {
      throw new QueueInvariantError("invalid_compare_and_swap");
    }

    let current;
    try {
      current = await this.#plugin.get({ key: objectId });
    } catch (error) {
      if (hasPluginCode(error, NOT_FOUND)) return false;
      throw error;
    }
    assertNativeRevision(current.revision);
    const decoded = fromNativeRecord(objectId, current.key, current.data, current.revision);
    if (decoded.revision !== expectedRevision) return false;

    try {
      const result = await this.#plugin.compareAndSwap({
        ...toNativeRecord(replacement),
        expectedRevision: current.revision,
      });
      assertNativeRevision(result.revision);
      return true;
    } catch (error) {
      if (hasPluginCode(error, REVISION_CONFLICT) || hasPluginCode(error, NOT_FOUND)) {
        return false;
      }
      throw error;
    }
  }
}

function toNativeRecord(record: CaptureChunkRecord): { key: string; data: string } {
  return {
    key: record.reservation.objectId,
    data: encodeStandardBase64(encodeCaptureRecord(record)),
  };
}

function fromNativeRecord(
  expectedObjectId: string,
  actualObjectId: string,
  encoded: string,
  nativeRevision: string,
): CaptureChunkRecord {
  assertNativeRevision(nativeRevision);
  let record: CaptureChunkRecord;
  try {
    record = decodeCaptureRecord(decodeStandardBase64(encoded));
  } catch {
    throw new QueueInvariantError("native_queue_integrity_failure");
  }
  if (actualObjectId !== expectedObjectId || record.reservation.objectId !== expectedObjectId) {
    throw new QueueInvariantError("native_queue_integrity_failure");
  }
  return record;
}

function encodeStandardBase64(value: string): string {
  const base64Url = base64UrlEncode(new TextEncoder().encode(value));
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  return base64Url.replaceAll("-", "+").replaceAll("_", "/") + padding;
}

function decodeStandardBase64(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new QueueInvariantError("native_queue_integrity_failure");
  }
  const unpadded = value.replace(/=+$/u, "").replaceAll("+", "-").replaceAll("/", "_");
  return new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(unpadded));
}

function assertNativeRevision(value: string): void {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new QueueInvariantError("native_queue_integrity_failure");
  }
}

function hasPluginCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
