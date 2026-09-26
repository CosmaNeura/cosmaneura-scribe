import { createHash, webcrypto } from "node:crypto";
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LocalSessionKeyWrapping, WrappedSessionKey } from "../../capture/src/flow/session-key";
import { base64UrlDecode } from "@cosmaneura-scribe/capture-protocol";

const FORMAT = 0x43534431;
const MAX_BYTES = 2_097_152;
const encoder = new TextEncoder();
const SENTINEL = encoder.encode("scribe-desktop-records:v1");
export interface DurableDesktopStoreOptions {
  readonly directory: string;
  readonly recoveryScope: string;
  readonly workspaceId: string;
  /** Stable device-protected key from the trusted host. Never generated here,
   * persisted in SQLite, obtained from a renderer or replaced after key loss. */
  readonly key: CryptoKey;
  readonly crypto?: Crypto;
}
export interface DesktopStoredRecord {
  readonly key: string;
  readonly revision: number;
  readonly data: Uint8Array<ArrayBuffer>;
}

/** Main-process encrypted persistence. SQLite is Node's built-in module; there
 * is no database service, downloaded dependency or browser-storage fallback. */
export class DurableDesktopRecordStore {
  private closed = false;
  private key: CryptoKey | undefined;
  private constructor(private readonly database: DatabaseSync, private readonly scope: string,
    private readonly crypto: Crypto, key: CryptoKey, private readonly directory: string) { this.key = key; }

  static async open(options: DurableDesktopStoreOptions): Promise<DurableDesktopRecordStore> {
    requireMain();
    const scope = digest(`${uuid(options.recoveryScope)}:${uuid(options.workspaceId)}`);
    const crypto = options.crypto ?? webcrypto as unknown as Crypto;
    assertKey(options.key);
    // Generate only a nonce/sentinel before opening the file; custody is supplied.
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aad = encoder.encode(`scribe-desktop:v1:${scope}:sentinel`);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, options.key, SENTINEL));
    let database: DatabaseSync | undefined;
    try {
      privateDirectory(options.directory);
      const path = join(options.directory, `${scope}.sqlite`);
      for (const suffix of ["", "-wal", "-shm", "-journal"]) privateFile(path + suffix, false);
      privateFile(path, true);
      database = new DatabaseSync(path, { enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false, allowExtension: false });
      database.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL;");
      const application = database.prepare("PRAGMA application_id").get()?.application_id;
      const version = database.prepare("PRAGMA user_version").get()?.user_version;
      database.exec("BEGIN IMMEDIATE");
      try {
        if (application === 0 && version === 0) {
          if (database.prepare("SELECT name FROM sqlite_master LIMIT 1").get()) throw failure();
          database.exec(`CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), nonce BLOB NOT NULL, ciphertext BLOB NOT NULL);
            CREATE TABLE records (namespace TEXT NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
              nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, PRIMARY KEY(namespace,digest));
            PRAGMA application_id=${String(FORMAT)}; PRAGMA user_version=1;`);
          database.prepare("INSERT INTO metadata VALUES (1,?,?)").run(nonce, sealed);
        } else if (application !== FORMAT || version !== 1) throw failure();
        database.exec("COMMIT");
      } catch { database.exec("ROLLBACK"); throw failure(); }
      const record = database.prepare("SELECT nonce,ciphertext FROM metadata WHERE id=1").get();
      if (!(record?.nonce instanceof Uint8Array) || !(record.ciphertext instanceof Uint8Array)
        || record.nonce.length !== 12 || record.ciphertext.length !== SENTINEL.length + 16) throw failure();
      const opened = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: owned(record.nonce), additionalData: aad },
        options.key, owned(record.ciphertext)));
      try { if (!opened.every((byte, i) => byte === SENTINEL[i]) || opened.length !== SENTINEL.length) throw failure(); }
      finally { opened.fill(0); }
      database.exec("PRAGMA journal_mode=WAL");
      return new DurableDesktopRecordStore(database, scope, crypto, options.key, options.directory);
    } catch { database?.close(); throw failure(); }
  }

  namespace(name: string): DesktopRecordNamespace {
    this.current(); identifier(name, 128);
    return new DesktopRecordNamespace(this, digest(name));
  }
  async availableBytes(): Promise<number> {
    this.current();
    const stats = await statfs(this.directory, { bigint: true });
    this.current();
    const bytes = stats.bavail * stats.bsize;
    if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw failure();
    return Number(bytes);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.key = undefined; this.database.close();
  }
  wrapping(namespace: string, sessionId: string): LocalSessionKeyWrapping {
    return { key: this.current(), additionalData: this.aad(namespace, `session-key:${uuid(sessionId)}`, 0) };
  }
  async unwrap(namespace: string, sessionId: string, value: NonNullable<WrappedSessionKey["localKey"]>): Promise<CryptoKey> {
    try {
      if (typeof value.nonce !== "string" || typeof value.ciphertext !== "string") throw failure();
      const nonce = base64UrlDecode(value.nonce), bytes = base64UrlDecode(value.ciphertext);
      if (nonce.length !== 12 || bytes.length !== 48) throw failure();
      const key = await this.crypto.subtle.unwrapKey("raw", owned(bytes), this.current(),
        { name: "AES-GCM", iv: owned(nonce), additionalData: this.aad(namespace, `session-key:${uuid(sessionId)}`, 0) },
        { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
      this.current(); return key;
    } catch { throw failure(); }
  }
  async get(namespace: string, key: string): Promise<DesktopStoredRecord | null> {
    this.current(); identifier(key, 512);
    const row = this.database.prepare("SELECT revision,nonce,ciphertext FROM records WHERE namespace=? AND digest=?").get(namespace, digest(key));
    return row ? this.openRecord(namespace, key, row) : null;
  }
  async list(namespace: string): Promise<readonly DesktopStoredRecord[]> {
    const result: DesktopStoredRecord[] = [];
    try {
      for await (const record of this.scan(namespace)) result.push({ ...record, data: record.data.slice() });
      return result;
    } catch { for (const record of result) record.data.fill(0); throw failure(); }
  }
  /** Only digests are enumerated. The yielded data is cleared when advancing/closing. */
  async *scan(namespace: string): AsyncGenerator<DesktopStoredRecord, void> {
    this.current();
    const rows = this.database.prepare("SELECT digest FROM records WHERE namespace=? ORDER BY digest LIMIT 2049").all(namespace);
    if (rows.length > 2048) throw failure();
    for (const entry of rows) {
      this.current();
      if (typeof entry.digest !== "string") throw failure();
      const row = this.database.prepare("SELECT revision,nonce,ciphertext FROM records WHERE namespace=? AND digest=?").get(namespace, entry.digest);
      if (!row) throw failure();
      const record = await this.openRecord(namespace, null, row, entry.digest);
      try { yield record; } finally { record.data.fill(0); }
    }
  }
  async save(namespace: string, key: string, expected: number | null, data: Uint8Array): Promise<number> {
    const encryptionKey = this.current(); identifier(key, 512);
    if (!(data instanceof Uint8Array) || data.length > MAX_BYTES
      || expected !== null && (!Number.isSafeInteger(expected) || expected < 1 || expected >= Number.MAX_SAFE_INTEGER)) throw failure();
    const revision = expected === null ? 1 : expected + 1, keyBytes = encoder.encode(key);
    const plaintext = new Uint8Array(2 + keyBytes.length + data.length);
    new DataView(plaintext.buffer).setUint16(0, keyBytes.length); plaintext.set(keyBytes, 2); plaintext.set(data, keyBytes.length + 2);
    const nonce = this.crypto.getRandomValues(new Uint8Array(12));
    let ciphertext: Uint8Array;
    try { ciphertext = new Uint8Array(await this.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
      additionalData: this.aad(namespace, digest(key), revision) }, encryptionKey, plaintext)); }
    finally { plaintext.fill(0); }
    this.current();
    try {
      const outcome = expected === null
        ? this.database.prepare("INSERT INTO records VALUES (?,?,?,?,?) ON CONFLICT(namespace,digest) DO NOTHING").run(namespace, digest(key), revision, nonce, ciphertext)
        : this.database.prepare("UPDATE records SET revision=?,nonce=?,ciphertext=? WHERE namespace=? AND digest=? AND revision=?")
          .run(revision, nonce, ciphertext, namespace, digest(key), expected);
      if (outcome.changes !== 1) throw conflict();
      return revision;
    } catch (error) { if (error instanceof Error && error.message === "desktop_storage_conflict") throw error; throw failure(); }
  }
  delete(namespace: string, key: string, revision: number): void {
    this.removeGroup(namespace, key, revision, []);
  }
  removeGroup(namespace: string, guardKey: string, revision: number, others: readonly string[]): void {
    this.current(); identifier(guardKey, 512); others.forEach(key => identifier(key, 512));
    if (!Number.isSafeInteger(revision) || revision < 1 || others.length > 8) throw failure();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("DELETE FROM records WHERE namespace=? AND digest=? AND revision=?").run(namespace, digest(guardKey), revision);
      if (result.changes !== 1) throw conflict();
      for (const key of others) this.database.prepare("DELETE FROM records WHERE namespace=? AND digest=?").run(namespace, digest(key));
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); if (error instanceof Error && error.message === "desktop_storage_conflict") throw error; throw failure(); }
  }
  private current(): CryptoKey { if (this.closed || !this.key) throw failure(); return this.key; }
  private aad(namespace: string, key: string, revision: number): Uint8Array<ArrayBuffer> {
    return encoder.encode(`scribe-desktop:v1:${this.scope}:${namespace}:${key}:${String(revision)}`);
  }
  private async openRecord(namespace: string, expectedKey: string | null, row: Record<string, unknown>, keyDigest = digest(expectedKey!)): Promise<DesktopStoredRecord> {
    const { revision, nonce, ciphertext } = row;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1
      || !(nonce instanceof Uint8Array) || nonce.length !== 12 || !(ciphertext instanceof Uint8Array)
      || ciphertext.length < 19 || ciphertext.length > MAX_BYTES + 530) throw failure();
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = new Uint8Array(await this.crypto.subtle.decrypt({ name: "AES-GCM", iv: owned(nonce),
      additionalData: this.aad(namespace, keyDigest, revision) }, this.current(), owned(ciphertext))); }
    catch { throw failure(); }
    try {
      this.current(); const length = new DataView(bytes.buffer).getUint16(0);
      if (length < 1 || length > 512 || length + 2 > bytes.length) throw failure();
      const key = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(2, length + 2));
      identifier(key, 512);
      if (digest(key) !== keyDigest || expectedKey !== null && expectedKey !== key) throw failure();
      return { key, revision, data: bytes.slice(length + 2) };
    } finally { bytes.fill(0); }
  }
}

export class DesktopRecordNamespace {
  constructor(private readonly store: DurableDesktopRecordStore, private readonly namespace: string) {}
  get(key: string): Promise<DesktopStoredRecord | null> { return this.store.get(this.namespace, key); }
  list(): Promise<readonly DesktopStoredRecord[]> { return this.store.list(this.namespace); }
  scan(): AsyncGenerator<DesktopStoredRecord, void> { return this.store.scan(this.namespace); }
  save(key: string, previous: number | null, bytes: Uint8Array): Promise<number> { return this.store.save(this.namespace, key, previous, bytes); }
  delete(key: string, revision: number): void { this.store.delete(this.namespace, key, revision); }
  removeGroup(key: string, revision: number, others: readonly string[]): void { this.store.removeGroup(this.namespace, key, revision, others); }
  wrapping(sessionId: string): LocalSessionKeyWrapping { return this.store.wrapping(this.namespace, sessionId); }
  unwrap(sessionId: string, value: NonNullable<WrappedSessionKey["localKey"]>): Promise<CryptoKey> { return this.store.unwrap(this.namespace, sessionId, value); }
}

function requireMain(): void {
  if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw failure();
}
function privateDirectory(path: string): void {
  if (!isAbsolute(path)) throw failure();
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw failure(); }
  const info = lstatSync(path);
  if (!info.isDirectory() || realpathSync(path) !== path || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw failure();
}
function privateFile(path: string, create: boolean): void {
  if (create) {
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw failure(); }
  }
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw failure();
  } catch (error) { if (create || !hasCode(error, "ENOENT")) throw failure(); }
}
function assertKey(key: CryptoKey): void {
  if (!key || key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM"
    || (key.algorithm as AesKeyAlgorithm).length !== 256
    || ["encrypt", "decrypt", "wrapKey", "unwrapKey"].some(use => !key.usages.includes(use as KeyUsage))) throw failure();
}
export function uuid(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw failure();
  return value.toLowerCase();
}
function identifier(value: string, max: number): void { if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9._:-]+$/u.test(value)) throw failure(); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function owned(value: Uint8Array): Uint8Array<ArrayBuffer> { return new Uint8Array(value); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
export function failure(): Error { return new Error("desktop_storage_unavailable"); }
export function conflict(): Error { return new Error("desktop_storage_conflict"); }
