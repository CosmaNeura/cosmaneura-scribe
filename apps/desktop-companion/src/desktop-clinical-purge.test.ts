import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import {
  abandonPreparedClinicalPurge, clearClinicalPurgePending, confirmClinicalPurgePending,
  createDesktopClinicalPurgeHost, listClinicalPurgePending, planDesktopClinicalPurge,
  purgePendingPath, readClinicalPurgePending, rememberDesktopClinicalWorkspace,
  resolveDesktopClinicalDirectoryScopes, resolvePreparedClinicalPurge, retryClinicalPurgePending,
  wipeDesktopClinicalDirectories, wipeDesktopClinicalPurgePlan, writeClinicalPurgePending,
  type DesktopClinicalPurgePlan,
} from "./desktop-clinical-purge.js";

const crypto = webcrypto as unknown as Crypto;
const wa = "11111111-1111-4111-8111-111111111111", wb = "22222222-2222-4222-8222-222222222222";
const ra = "33333333-3333-4333-8333-333333333333", rb = "44444444-4444-4444-8444-444444444444";
const digest = (r: string, w: string) => createHash("sha256").update(`${r}:${w}`).digest("hex");
async function seed(dir: string, r: string, w: string): Promise<void> {
  const store = await DurableDesktopRecordStore.open({
    directory: dir, recoveryScope: r, workspaceId: w,
    key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false,
      ["encrypt", "decrypt", "wrapKey", "unwrapKey"]),
  });
  await store.namespace("seed").save("row", null, new Uint8Array([1])); store.close();
  writeFileSync(join(dir, `${digest(r, w)}.key`), "synthetic-key", { mode: 0o600 });
}
const has = async (dir: string, r: string, w: string) =>
  (await readdir(dir)).some(name => name.startsWith(digest(r, w)));
async function seedBoth(root: string) {
  const records = join(root, "provider-records-v1"), creation = join(root, "provider-creation-v1");
  for (const [r, w] of [[ra, wa], [rb, wb]] as const) {
    await seed(records, r, w); await seed(creation, r, w);
  }
  return { records, creation };
}

describe("desktop clinical purge", () => {
  it("wipes deleter scopes+.key only; prepare survives 401 catalog; marker retry; H1/H5/H15", async () => {
    expect(() => resolveDesktopClinicalDirectoryScopes({
      recoveryScope: null, recordsWorkspaceId: wa, creationWorkspaceId: wa,
    })).toThrow(/desktop_clinical_scope_unavailable/);
    const root = await mkdtemp(join(realpathSync(tmpdir()), "scribe-clinical-purge-"));
    try {
      const { records, creation } = await seedBoth(root);
      wipeDesktopClinicalDirectories(root, resolveDesktopClinicalDirectoryScopes({
        recoveryScope: ra, recordsWorkspaceId: wa, creationWorkspaceId: wa,
      }));
      expect(await has(records, ra, wa)).toBe(false); expect(await has(records, rb, wb)).toBe(true);

      let catalogCalls = 0, phase: "ready" | "deleted" = "ready";
      rememberDesktopClinicalWorkspace(root, ra, wb);
      const host = createDesktopClinicalPurgeHost({
        userDataDirectory: root, creationWorkspaceId: wa,
        loadCatalog: async () => {
          catalogCalls += 1;
          if (phase !== "ready") throw Object.assign(new Error("unauthorized"), { status: 401 });
          return { recoveryScope: ra, encounters: [{ workspaceId: wa }] };
        },
      });
      const wipe = await host.prepareClinicalPurge();
      expect(catalogCalls).toBe(1); expect(readClinicalPurgePending(root, ra)?.state).toBe("prepared");
      phase = "deleted"; await wipe();
      expect(catalogCalls).toBe(1); expect(await has(creation, ra, wa)).toBe(false);
      expect(await has(creation, rb, wb)).toBe(true); expect(readClinicalPurgePending(root, ra)).toBeNull();

      let failOnce = true;
      const wipeFn = vi.fn((dir: string, next: DesktopClinicalPurgePlan) => {
        if (failOnce) { failOnce = false; throw new Error("wipe_failed"); }
        wipeDesktopClinicalPurgePlan(dir, next);
      });
      const host2 = createDesktopClinicalPurgeHost({
        userDataDirectory: root, creationWorkspaceId: wa,
        loadCatalog: async () => ({ recoveryScope: ra, encounters: [] }), wipe: wipeFn,
      });
      await expect((await host2.prepareClinicalPurge())()).rejects.toThrow(/clinical_purge_wipe_failed/);
      expect(readClinicalPurgePending(root, ra)?.state).toBe("confirmed");
      expect(retryClinicalPurgePending(root, { wipe: wipeFn })).toBe(true);
      expect(readClinicalPurgePending(root, ra)).toBeNull();

      // prepared not wiped at launch; catalog fail does not block (H15)
      const host3 = createDesktopClinicalPurgeHost({
        userDataDirectory: root, creationWorkspaceId: wa, recoveryScope: () => rb,
        loadCatalog: async () => { throw new Error("catalog_down"); },
      });
      await host3.prepareClinicalPurge();
      expect(readClinicalPurgePending(root, rb)?.state).toBe("prepared");
      expect(retryClinicalPurgePending(root)).toBe(false);
      host3.abandonClinicalPurge();
      expect(readClinicalPurgePending(root, rb)).toBeNull();

      // per-scope: abandon prepared must not clear another account's confirmed
      confirmClinicalPurgePending(root, {
        recoveryScope: ra, creationWorkspaceId: wa, recordsWorkspaceIds: [wa], state: "confirmed",
      });
      const other = createDesktopClinicalPurgeHost({
        userDataDirectory: root, creationWorkspaceId: wb, recoveryScope: () => rb,
        loadCatalog: async () => ({ recoveryScope: rb }),
      });
      await other.prepareClinicalPurge(); other.abandonClinicalPurge();
      expect(readClinicalPurgePending(root, ra)?.state).toBe("confirmed");
      abandonPreparedClinicalPurge(root, ra);
      expect(readClinicalPurgePending(root, ra)?.state).toBe("confirmed");
      expect(listClinicalPurgePending(root).some(p => p.recoveryScope === ra)).toBe(true);
      expect(existsSync(purgePendingPath(root, ra))).toBe(true);
      expect([...planDesktopClinicalPurge(ra, wa, [wb]).recordsWorkspaceIds].sort()).toEqual([wa, wb].sort());
      clearClinicalPurgePending(root, ra);

      // B4/B5: prepared at launch does not wipe; signedOut/unavailable observation does not wipe.
      const wipeSpy = vi.fn(wipeDesktopClinicalPurgePlan);
      writeClinicalPurgePending(root, {
        recoveryScope: ra, creationWorkspaceId: wa, recordsWorkspaceIds: [wa], state: "prepared",
      });
      expect(retryClinicalPurgePending(root, { wipe: wipeSpy })).toBe(false);
      expect(wipeSpy).not.toHaveBeenCalled();
      expect(readClinicalPurgePending(root, ra)?.state).toBe("prepared");
      resolvePreparedClinicalPurge(root, { revoked: true });
      expect(wipeSpy).not.toHaveBeenCalled();
      expect(readClinicalPurgePending(root, ra)?.state).toBe("prepared");
      resolvePreparedClinicalPurge(root, { recoveryScope: ra, revoked: false });
      expect(readClinicalPurgePending(root, ra)).toBeNull();
      expect(wipeSpy).not.toHaveBeenCalled();
    } finally {
      clearClinicalPurgePending(root, ra); clearClinicalPurgePending(root, rb);
      await rm(root, { recursive: true, force: true });
    }
  });
});
