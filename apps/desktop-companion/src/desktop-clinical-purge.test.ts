import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import {
  resolveDesktopClinicalDirectoryScopes, wipeDesktopClinicalDirectories,
} from "./desktop-clinical-purge.js";

const crypto = webcrypto as unknown as Crypto;
const wa = "11111111-1111-4111-8111-111111111111", wb = "22222222-2222-4222-8222-222222222222";
const ra = "33333333-3333-4333-8333-333333333333", rb = "44444444-4444-4444-8444-444444444444";

async function master(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}
function digest(r: string, w: string): string {
  return createHash("sha256").update(`${r}:${w}`).digest("hex");
}
async function seed(dir: string, r: string, w: string): Promise<void> {
  const store = await DurableDesktopRecordStore.open({ directory: dir, recoveryScope: r, workspaceId: w, key: await master() });
  await store.namespace("seed").save("row", null, new Uint8Array([1])); store.close();
}
async function has(dir: string, r: string, w: string): Promise<boolean> {
  return (await readdir(dir)).some(name => name.startsWith(digest(r, w)));
}

describe("desktop clinical purge scopes (standalone-provider wipe path)", () => {
  it("refuses missing scopes; wipes both directories for deleting account only", async () => {
    expect(() => resolveDesktopClinicalDirectoryScopes({
      recoveryScope: null, recordsWorkspaceId: wa, creationWorkspaceId: wa,
    })).toThrow(/desktop_clinical_scope_unavailable/);
    const root = await mkdtemp(join(realpathSync(tmpdir()), "scribe-clinical-purge-"));
    const records = join(root, "provider-records-v1"), creation = join(root, "provider-creation-v1");
    try {
      for (const [r, w] of [[ra, wa], [rb, wb]] as const) {
        await seed(records, r, w); await seed(creation, r, w);
      }
      // No prior custody: wipe A from authenticated session scopes only.
      wipeDesktopClinicalDirectories(root, resolveDesktopClinicalDirectoryScopes({
        recoveryScope: ra, recordsWorkspaceId: wa, creationWorkspaceId: wa,
      }));
      expect(await has(records, ra, wa)).toBe(false); expect(await has(creation, ra, wa)).toBe(false);
      expect(await has(records, rb, wb)).toBe(true); expect(await has(creation, rb, wb)).toBe(true);
      // After account switch: wipe B from the authenticated session.
      wipeDesktopClinicalDirectories(root, resolveDesktopClinicalDirectoryScopes({
        recoveryScope: rb, recordsWorkspaceId: wb, creationWorkspaceId: wb,
      }));
      expect(await has(records, rb, wb)).toBe(false); expect(await has(creation, rb, wb)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
