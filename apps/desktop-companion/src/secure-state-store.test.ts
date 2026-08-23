import { describe, expect, it } from "vitest";

import type { EncryptedStateFilePort, ElectronSafeStoragePort } from "./secure-state-store.js";
import {
  DesktopSecureStateStore,
  DesktopSecureStoreError,
} from "./secure-state-store.js";

class MemoryFile implements EncryptedStateFilePort {
  value: string | null = null;

  read(): Promise<string | null> {
    return Promise.resolve(this.value);
  }

  replace(value: string): Promise<void> {
    this.value = value;
    return Promise.resolve();
  }
}

class SyntheticEncryption implements ElectronSafeStoragePort {
  available = true;

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Uint8Array {
    return Buffer.from(`protected:${Buffer.from(value).toString("base64")}`);
  }

  decryptString(value: Uint8Array): string {
    const encoded = Buffer.from(value).toString("utf8");
    if (!encoded.startsWith("protected:")) {
      throw new Error("invalid ciphertext");
    }
    return Buffer.from(encoded.slice("protected:".length), "base64").toString(
      "utf8",
    );
  }
}

describe("desktop protected state", () => {
  it("creates and reuses an encrypted installation secret", async () => {
    const file = new MemoryFile();
    const store = new DesktopSecureStateStore(new SyntheticEncryption(), file);
    const first = await store.load();
    const second = await store.load();

    expect(first.installationSecret).toHaveLength(43);
    expect(second.installationSecret).toBe(first.installationSecret);
    expect(file.value).not.toContain(first.installationSecret);
  });

  it("serializes updates without losing protected fields", async () => {
    const file = new MemoryFile();
    const store = new DesktopSecureStateStore(new SyntheticEncryption(), file);
    const before = await store.load();
    const pending = {
      schemaVersion: 1,
      state: "s".repeat(43),
      codeVerifier: "v".repeat(43),
      redirectUri: "cosmaneura-capture://oauth/callback",
      createdAt: "2030-01-01T00:00:00.000Z",
    } as const;

    const updated = await store.update((state) => ({
      ...state,
      pendingAuthorization: pending,
    }));
    expect(updated.installationSecret).toBe(before.installationSecret);
    expect((await store.load()).pendingAuthorization).toEqual(pending);
    expect(file.value).not.toContain(pending.codeVerifier);
  });

  it("fails closed when OS encryption is unavailable or state is malformed", async () => {
    const encryption = new SyntheticEncryption();
    encryption.available = false;
    await expect(
      new DesktopSecureStateStore(encryption, new MemoryFile()).load(),
    ).rejects.toBeInstanceOf(DesktopSecureStoreError);

    encryption.available = true;
    const file = new MemoryFile();
    file.value = Buffer.from("not-protected").toString("base64");
    await expect(
      new DesktopSecureStateStore(encryption, file).load(),
    ).rejects.toBeInstanceOf(DesktopSecureStoreError);
  });
});
