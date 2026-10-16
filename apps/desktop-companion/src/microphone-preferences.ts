import { createHash } from "node:crypto";
import type { ProviderAccount } from "../../capture/src/provider/encounter-setup";
import { openDeviceCustody, type DeviceProtection } from "./device-custody.js";
import { DurableDesktopRecordStore } from "./durable-record-store.js";

const workspaceId = "7d96d823-f2ba-4d85-9f36-cac3b09b9166";
/** A purpose-specific hash of the current authenticated Core account. Account
 * display values never become filenames, SQLite plaintext or renderer IDs. */
export function microphonePreferenceScope(account: ProviderAccount): string {
  if (!account.email || account.email.length > 320 || !account.environment || account.environment.length > 64) throw unavailable();
  const digest = createHash("sha256").update(`scribe-microphone-preference-v1:${account.environment}:${account.email.trim().toLowerCase()}`).digest("hex");
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
}

/** Main-only nonclinical preference protected by the same macOS device key
 * custody and encrypted CAS records as the native app. A missing/corrupt key
 * leaves an existing preference unavailable; it is never replaced silently. */
export async function openMicrophonePreferences(directory: string, protection: DeviceProtection,
  account: ProviderAccount, signal: AbortSignal): Promise<{
    load(): Promise<string | null>; save(uid: string): Promise<void>; close(): Promise<void>;
  }> {
  const recoveryScope = microphonePreferenceScope(account);
  if (signal.aborted) throw unavailable();
  const custody = await openDeviceCustody(directory, protection, {recoveryScope,workspaceId}, signal);
  let store: DurableDesktopRecordStore;
  try {
    store = await DurableDesktopRecordStore.open({directory,recoveryScope,workspaceId,key:custody.key});
    if (signal.aborted) { store.close(); throw unavailable(); }
  } catch (error) { await custody.release(); throw error; }
  const records = store.namespace("microphone-preference-v1");
  let closed = false, tail: Promise<void> = Promise.resolve();
  const current = (): void => { if (closed || signal.aborted) throw unavailable(); };
  // Closing the actual store synchronously fences a save that is suspended in
  // WebCrypto. Its post-encryption current check cannot commit after revocation.
  const revoked = (): void => { closed = true; store.close(); };
  signal.addEventListener("abort", revoked, {once:true});
  const read = async (): Promise<{uid:string;revision:number}|null> => {
    current(); const value = await records.get("selected-input");
    if (!value) { current();return null; }
    try {
      current();
      const input: unknown = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(value.data));
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "microphoneUID,schema"
        || !("schema" in input) || input.schema !== 1 || !("microphoneUID" in input) || !validUID(input.microphoneUID)) throw unavailable();
      return {uid:input.microphoneUID,revision:value.revision};
    } finally { value.data.fill(0); }
  };
  return {
    load: async () => (await read())?.uid ?? null,
    save: uid => {
      if (!validUID(uid)) return Promise.reject(unavailable());
      const work = tail.catch(()=>undefined).then(async () => {
        current(); const prior=await read(); current();
        if (prior?.uid === uid) return;
        const bytes=new TextEncoder().encode(JSON.stringify({schema:1,microphoneUID:uid}));
        try { await records.save("selected-input",prior?.revision??null,bytes); current(); }
        finally { bytes.fill(0); }
      });
      tail=work; return work;
    },
    close: async () => { revoked(); signal.removeEventListener("abort",revoked); await tail.catch(()=>undefined); await custody.release(); },
  };
}
function validUID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value,"utf8") <= 511
    && ![...value].some(character=>character.codePointAt(0)!<32||character.codePointAt(0)===127);
}
function unavailable(): Error { return new Error("Microphone preference is unavailable."); }
