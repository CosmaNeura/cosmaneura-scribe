import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  generateOpaqueSecret,
  parsePendingDesktopAuthorization,
  type PendingDesktopAuthorization,
} from "./browser-handoff.js";
import {
  parseDesktopSessionCredential,
  type DesktopSessionCredential,
} from "./desktop-api.js";
import { parseMetadataIdentifier } from "./protocol.js";

const MAX_ENCRYPTED_STATE_BYTES = 128 * 1024;
const MAX_PENDING_STOP_RECEIPTS = 32;

export interface PendingStopReceipt {
  readonly captureSessionId: string;
  readonly capabilityId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface DesktopProtectedState {
  readonly schemaVersion: 1;
  readonly installationSecret: string;
  readonly pendingAuthorization: PendingDesktopAuthorization | null;
  readonly sessionCredential: DesktopSessionCredential | null;
  readonly pendingStopReceipts: readonly PendingStopReceipt[];
}

export interface ElectronSafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

export interface EncryptedStateFilePort {
  read(): Promise<string | null>;
  replace(value: string): Promise<void>;
}

export class DesktopSecureStoreError extends Error {
  constructor() {
    super("Desktop protected state is unavailable");
    this.name = "DesktopSecureStoreError";
  }
}

export class DesktopSecureStateStore {
  readonly #encryption: ElectronSafeStoragePort;
  readonly #file: EncryptedStateFilePort;
  #operation: Promise<unknown> = Promise.resolve();

  constructor(
    encryption: ElectronSafeStoragePort,
    file: EncryptedStateFilePort,
  ) {
    this.#encryption = encryption;
    this.#file = file;
  }

  load(): Promise<DesktopProtectedState> {
    return this.#serialized(async () => this.#loadUnlocked());
  }

  update(
    mutate: (state: DesktopProtectedState) => DesktopProtectedState,
  ): Promise<DesktopProtectedState> {
    return this.#serialized(async () => {
      const next = parseDesktopProtectedState(mutate(await this.#loadUnlocked()));
      await this.#saveUnlocked(next);
      return next;
    });
  }

  async #loadUnlocked(): Promise<DesktopProtectedState> {
    this.#requireEncryption();
    const encoded = await this.#file.read();
    if (encoded === null) {
      const initial = emptyDesktopProtectedState();
      await this.#saveUnlocked(initial);
      return initial;
    }
    if (encoded.length > MAX_ENCRYPTED_STATE_BYTES) {
      throw new DesktopSecureStoreError();
    }
    try {
      const ciphertext = Buffer.from(encoded, "base64");
      if (ciphertext.length === 0) {
        throw new DesktopSecureStoreError();
      }
      const plaintext = this.#encryption.decryptString(ciphertext);
      return parseDesktopProtectedState(JSON.parse(plaintext) as unknown);
    } catch (error) {
      if (error instanceof DesktopSecureStoreError) {
        throw error;
      }
      throw new DesktopSecureStoreError();
    }
  }

  async #saveUnlocked(state: DesktopProtectedState): Promise<void> {
    this.#requireEncryption();
    try {
      const ciphertext = this.#encryption.encryptString(JSON.stringify(state));
      const encoded = Buffer.from(ciphertext).toString("base64");
      if (encoded.length === 0 || encoded.length > MAX_ENCRYPTED_STATE_BYTES) {
        throw new DesktopSecureStoreError();
      }
      await this.#file.replace(encoded);
    } catch (error) {
      if (error instanceof DesktopSecureStoreError) {
        throw error;
      }
      throw new DesktopSecureStoreError();
    }
  }

  #requireEncryption(): void {
    if (!this.#encryption.isEncryptionAvailable()) {
      throw new DesktopSecureStoreError();
    }
  }

  #serialized<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.catch(() => undefined);
    return result;
  }
}

export class NodeEncryptedStateFile implements EncryptedStateFilePort {
  readonly #directory: string;
  readonly #path: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.#path = join(directory, "desktop-state-v1.enc");
  }

  async read(): Promise<string | null> {
    try {
      const metadata = await lstat(this.#path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new DesktopSecureStoreError();
      }
      if (metadata.size > MAX_ENCRYPTED_STATE_BYTES) {
        throw new DesktopSecureStoreError();
      }
      return await readFile(this.#path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      if (error instanceof DesktopSecureStoreError) {
        throw error;
      }
      throw new DesktopSecureStoreError();
    }
  }

  async replace(value: string): Promise<void> {
    if (value.length === 0 || value.length > MAX_ENCRYPTED_STATE_BYTES) {
      throw new DesktopSecureStoreError();
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      this.#directory,
      `.desktop-state-v1.${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temporaryPath, value, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#path);
      await chmod(this.#path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof DesktopSecureStoreError) {
        throw error;
      }
      throw new DesktopSecureStoreError();
    }
  }
}

export function emptyDesktopProtectedState(): DesktopProtectedState {
  return Object.freeze({
    schemaVersion: 1,
    installationSecret: generateOpaqueSecret(),
    pendingAuthorization: null,
    sessionCredential: null,
    pendingStopReceipts: Object.freeze([]),
  });
}

export function parseDesktopProtectedState(
  value: unknown,
): DesktopProtectedState {
  const state = asRecord(value);
  assertExactKeys(state, [
    "schemaVersion",
    "installationSecret",
    "pendingAuthorization",
    "sessionCredential",
    "pendingStopReceipts",
  ]);
  if (state.schemaVersion !== 1 || !isOpaqueSecret(state.installationSecret)) {
    throw new DesktopSecureStoreError();
  }
  if (!Array.isArray(state.pendingStopReceipts)) {
    throw new DesktopSecureStoreError();
  }
  if (state.pendingStopReceipts.length > MAX_PENDING_STOP_RECEIPTS) {
    throw new DesktopSecureStoreError();
  }
  return Object.freeze({
    schemaVersion: 1,
    installationSecret: state.installationSecret,
    pendingAuthorization:
      state.pendingAuthorization === null
        ? null
        : parsePendingDesktopAuthorization(state.pendingAuthorization),
    sessionCredential:
      state.sessionCredential === null
        ? null
        : parseDesktopSessionCredential(state.sessionCredential),
    pendingStopReceipts: Object.freeze(
      state.pendingStopReceipts.map(parsePendingStopReceipt),
    ),
  });
}

function parsePendingStopReceipt(value: unknown): PendingStopReceipt {
  const receipt = asRecord(value);
  assertExactKeys(receipt, [
    "captureSessionId",
    "capabilityId",
    "idempotencyKey",
    "createdAt",
  ]);
  if (
    typeof receipt.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._~-]{7,254}$/u.test(receipt.idempotencyKey)
  ) {
    throw new DesktopSecureStoreError();
  }
  return Object.freeze({
    captureSessionId: parseMetadataIdentifier(receipt.captureSessionId),
    capabilityId: parseMetadataIdentifier(receipt.capabilityId),
    idempotencyKey: receipt.idempotencyKey,
    createdAt: parseIsoTimestamp(receipt.createdAt),
  });
}

function isOpaqueSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/u.test(value);
}

function parseIsoTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !value.endsWith("Z") ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new DesktopSecureStoreError();
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DesktopSecureStoreError();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new DesktopSecureStoreError();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
