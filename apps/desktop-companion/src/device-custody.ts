import { createHash, randomBytes, webcrypto } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { uuid } from "./durable-record-store.js";

export interface DeviceProtection {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Electron's macOS Keychain protection, in the standalone app namespace.
 * A missing/corrupt key never replaces custody of an existing journal. */
export async function openDeviceCustody(directory: string, protection: DeviceProtection,
  scope: { recoveryScope: string; workspaceId: string }, signal: AbortSignal): Promise<{
    key: CryptoKey; release(): Promise<void>;
  }> {
  const current = (): void => {
    if (process.platform !== "darwin" || typeof window !== "undefined"
      || "type" in process && process.type === "renderer" || signal.aborted
      || !protection.isEncryptionAvailable()) throw unavailable();
  };
  current(); privateDirectory(directory);
  const identity = `${uuid(scope.recoveryScope)}:${uuid(scope.workspaceId)}`;
  const name = createHash("sha256").update(identity).digest("hex");
  const keyPath = join(directory, `${name}.key`);
  if (!existsSync(keyPath)) {
    if (["", "-wal", "-shm", "-journal"].some(suffix => existsSync(join(directory, `${name}.sqlite${suffix}`)))) throw unavailable();
    const raw = randomBytes(32);
    try {
      const sealed = protection.encryptString(JSON.stringify({ version: 1, scope: identity, key: raw.toString("hex") }));
      try {
        current();
        const descriptor = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(descriptor, sealed); fsyncSync(descriptor); }
        finally { closeSync(descriptor); }
        const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      } finally { sealed.fill(0); }
    } finally { raw.fill(0); }
  }
  const descriptor = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sealed: Buffer;
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()
      || (info.mode & 0o077) !== 0 || info.size < 16 || info.size > 4096) throw unavailable();
    sealed = readFileSync(descriptor);
  } finally { closeSync(descriptor); }
  let value: unknown;
  try { value = JSON.parse(protection.decryptString(sealed)); }
  catch { throw unavailable(); }
  finally { sealed.fill(0); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "key,scope,version"
    || !("version" in value) || value.version !== 1 || !("scope" in value) || value.scope !== identity
    || !("key" in value) || typeof value.key !== "string" || !/^[0-9a-f]{64}$/u.test(value.key)) throw unavailable();
  const raw = Buffer.from(value.key, "hex"); value.key = "";
  try {
    const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
    current(); return { key: key as CryptoKey, release: () => Promise.resolve() };
  } finally { raw.fill(0); }
}

function privateDirectory(path: string): void {
  if (!isAbsolute(path)) throw unavailable();
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw unavailable(); }
  const info = lstatSync(path);
  if (!info.isDirectory() || realpathSync(path) !== path || info.uid !== process.getuid?.()
    || (info.mode & 0o077) !== 0) throw unavailable();
}
function unavailable(): Error { return new Error("Desktop device custody is unavailable."); }
