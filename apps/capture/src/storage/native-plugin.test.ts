import type {
  SecureQueueCompareAndSwapOptions,
  SecureQueuePlugin,
  SecureQueueRecord,
} from "@cosmaneura-scribe/capacitor-secure-queue";
import {
  base64UrlEncode,
  encodeChunkAdditionalDataBase64Url,
  encodeEnvelope,
  NONCE_BYTES,
  PROTOCOL_VERSION,
} from "@cosmaneura-scribe/capture-protocol";
import { describe, expect, it } from "vitest";

import { attachEncryptedEnvelope, createReservedRecord } from "../queue/records";
import { NativePluginQueueStorage } from "./native-plugin";

const OBJECT_ID = "80000000-0000-4000-8000-000000000008";
const SESSION_ID = "90000000-0000-4000-8000-000000000009";
const TENANT_ID = "a0000000-0000-4000-8000-00000000000a";

describe("NativePluginQueueStorage", () => {
  it("keeps review recovery metadata out of audio queue decoding and draining", async () => {
    const plugin = new FakeSecureQueuePlugin();
    const storage = new NativePluginQueueStorage(plugin);
    await storage.create(reservedRecord());
    await plugin.create({ key: `creator-review-v1:${TENANT_ID}:${SESSION_ID}`, data: btoa("review metadata") });
    await plugin.create({ key: `provider-workspace-v1:${TENANT_ID}:${SESSION_ID}`, data: btoa("provider recovery") });
    await plugin.create({ key: `scribe-provider-queue:v1:${TENANT_ID}:${SESSION_ID}:${SESSION_ID}:${OBJECT_ID}`,
      data: btoa("separately scoped provider queue") });
    expect(await storage.list()).toEqual([reservedRecord()]);
    expect((await plugin.list()).keys).toHaveLength(4);
  });
  it("maps logical revisions onto atomic opaque native revisions", async () => {
    const plugin = new FakeSecureQueuePlugin();
    const storage = new NativePluginQueueStorage(plugin);
    const reserved = reservedRecord();

    expect(await storage.create(reserved)).toBe(true);
    expect(await storage.create(reserved)).toBe(false);
    expect(await storage.get(OBJECT_ID)).toEqual(reserved);
    expect(plugin.lastData).toMatch(/={0,2}$/u);
    expect(plugin.lastData).not.toContain("reservation");

    const encrypted = attachEncryptedEnvelope(reserved, envelopeFixture(), "0".repeat(64));
    expect(await storage.compareAndSwap(OBJECT_ID, 1, encrypted)).toBe(true);
    expect((await storage.get(OBJECT_ID))?.state).toBe("encrypted");
    expect(await storage.compareAndSwap(OBJECT_ID, 1, encrypted)).toBe(false);
  });

  it("maps a native CAS race to false without overwriting the winner", async () => {
    const plugin = new FakeSecureQueuePlugin();
    const storage = new NativePluginQueueStorage(plugin);
    const reserved = reservedRecord();
    await storage.create(reserved);
    plugin.forceConflict = true;

    const encrypted = attachEncryptedEnvelope(reserved, envelopeFixture(), "0".repeat(64));
    expect(await storage.compareAndSwap(OBJECT_ID, 1, encrypted)).toBe(false);
    expect((await storage.get(OBJECT_ID))?.state).toBe("reserved");
  });
});

class FakeSecureQueuePlugin implements SecureQueuePlugin {
  readonly #records = new Map<string, { data: string; revision: bigint }>();
  forceConflict = false;
  lastData = "";

  async put(options: SecureQueueRecord) {
    return this.#write(options);
  }

  async create(options: SecureQueueRecord) {
    if (this.#records.has(options.key)) throw pluginError("SECURE_QUEUE_ALREADY_EXISTS");
    return this.#write(options);
  }

  async get(options: { key: string }) {
    const value = this.#records.get(options.key);
    if (value === undefined) throw pluginError("SECURE_QUEUE_NOT_FOUND");
    return { key: options.key, data: value.data, revision: value.revision.toString() };
  }

  async list() {
    return { keys: [...this.#records.keys()] };
  }

  async compareAndSwap(options: SecureQueueCompareAndSwapOptions) {
    const value = this.#records.get(options.key);
    if (value === undefined) throw pluginError("SECURE_QUEUE_NOT_FOUND");
    if (this.forceConflict || value.revision.toString() !== options.expectedRevision) {
      this.forceConflict = false;
      throw pluginError("SECURE_QUEUE_REVISION_CONFLICT");
    }
    return this.#write(options);
  }

  async delete(options: { key: string }) {
    return { deleted: this.#records.delete(options.key) };
  }

  async clear() {
    const cleared = this.#records.size;
    this.#records.clear();
    return { cleared };
  }

  async #write(options: SecureQueueRecord) {
    const revision = (this.#records.get(options.key)?.revision ?? 0n) + 1n;
    this.lastData = options.data;
    this.#records.set(options.key, { data: options.data, revision });
    return { revision: revision.toString() };
  }
}

function reservedRecord() {
  return createReservedRecord(
    {
      protocolVersion: PROTOCOL_VERSION,
      objectId: OBJECT_ID,
      sessionId: SESSION_ID,
      channel: "microphone",
      sequenceNumber: 0,
      additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        objectId: OBJECT_ID,
        sequenceNumber: 0,
        channel: "microphone",
      }),
      createdAt: "2026-08-17T12:00:00.000Z",
    },
    {
      reservation: "reservation-idempotency-0001",
      uploadAuthorization: "authorization-idempotency-0001",
      uploadAuthorizationGeneration: 1,
      registration: "registration-idempotency-0001",
    },
  );
}

function envelopeFixture(): Uint8Array {
  return encodeEnvelope(
    {
      schema_version: PROTOCOL_VERSION,
      content_encryption: "A256GCM",
      nonce: base64UrlEncode(new Uint8Array(NONCE_BYTES).fill(11)),
      media_type: "audio/wav",
    },
    new Uint8Array(48).fill(12),
  );
}

function pluginError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
