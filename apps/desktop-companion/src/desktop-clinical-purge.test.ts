import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import {
  clearClinicalPurgePending, createDesktopClinicalPurgeHost, planDesktopClinicalPurge,
  purgePendingPath, readClinicalPurgePending, resolveDesktopClinicalDirectoryScopes,
  retryClinicalPurgePending, wipeDesktopClinicalDirectories, wipeDesktopClinicalPurgePlan,
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
}
async function has(dir: string, r: string, w: string): Promise<boolean> {
  return (await readdir(dir)).some(name => name.startsWith(digest(r, w)));
}
async function seedBoth(root: string): Promise<{ records: string; creation: string }> {
  const records = join(root, "provider-records-v1"), creation = join(root, "provider-creation-v1");
  for (const [r, w] of [[ra, wa], [rb, wb]] as const) {
    await seed(records, r, w); await seed(creation, r, w);
  }
  return { records, creation };
}

describe("desktop clinical purge scopes (standalone-provider wipe path)", () => {
  it("refuses missing scopes; wipes both directories for deleting account only", async () => {
    expect(() => resolveDesktopClinicalDirectoryScopes({
      recoveryScope: null, recordsWorkspaceId: wa, creationWorkspaceId: wa,
    })).toThrow(/desktop_clinical_scope_unavailable/);
    const root = await mkdtemp(join(realpathSync(tmpdir()), "scribe-clinical-purge-"));
    try {
      const { records, creation } = await seedBoth(root);
      wipeDesktopClinicalDirectories(root, resolveDesktopClinicalDirectoryScopes({
        recoveryScope: ra, recordsWorkspaceId: wa, creationWorkspaceId: wa,
      }));
      expect(await has(records, ra, wa)).toBe(false); expect(await has(creation, ra, wa)).toBe(false);
      expect(await has(records, rb, wb)).toBe(true); expect(await has(creation, rb, wb)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("captures scopes before DELETE; 401 catalog after delete still wipes only the deleter", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "scribe-clinical-purge-pre-"));
    let catalogCalls = 0, phase: "ready" | "deleted" = "ready";
    const loadCatalog = async (): Promise<Record<string, unknown>> => {
      catalogCalls += 1;
      if (phase !== "ready") throw Object.assign(new Error("unauthorized"), { status: 401 });
      return { recoveryScope: ra, revision: "rev", encounters: [{ workspaceId: wa }] };
    };
    try {
      const { records, creation } = await seedBoth(root);
      const host = createDesktopClinicalPurgeHost({
        userDataDirectory: root, creationWorkspaceId: wa, loadCatalog,
      });
      const wipe = await host.prepareClinicalPurge();
      expect(catalogCalls).toBe(1); expect(existsSync(purgePendingPath(root))).toBe(true);
      phase = "deleted"; await wipe();
      expect(catalogCalls).toBe(1);
      expect(await has(records, ra, wa)).toBe(false); expect(await has(creation, ra, wa)).toBe(false);
      expect(await has(records, rb, wb)).toBe(true); expect(await has(creation, rb, wb)).toBe(true);
      expect(readClinicalPurgePending(root)).toBeNull();
      expect(planDesktopClinicalPurge({
        recoveryScope: ra, encounters: [{ workspaceId: wa }, { workspaceId: wb }],
      }, wa).recordsWorkspaceIds).toEqual([wa, wb]);
      expect(() => planDesktopClinicalPurge({ recoveryScope: null }, wa))
        .toThrow(/desktop_clinical_scope_unavailable/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the purge-pending marker when wipe fails and completes on next-launch retry", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "scribe-clinical-purge-retry-"));
    const plan: DesktopClinicalPurgePlan = {
      recoveryScope: ra, creationWorkspaceId: wa, recordsWorkspaceIds: [wa],
    };
    let failOnce = true;
    const wipe = vi.fn((dir: string, next: DesktopClinicalPurgePlan) => {
      if (failOnce) { failOnce = false; throw new Error("wipe_failed"); }
      wipeDesktopClinicalPurgePlan(dir, next);
    });
    const log = vi.fn();
    try {
      const { records, creation } = await seedBoth(root);
      const host = createDesktopClinicalPurgeHost({
        userDataDirectory: root, creationWorkspaceId: wa,
        loadCatalog: async () => ({ recoveryScope: ra, encounters: [] }), wipe, log,
      });
      await expect((await host.prepareClinicalPurge())()).rejects.toThrow(/clinical_purge_wipe_failed/);
      expect(log).toHaveBeenCalledWith("clinical_purge_wipe_failed");
      expect(readClinicalPurgePending(root)).toMatchObject(plan);
      expect(await has(records, ra, wa)).toBe(true);
      expect(retryClinicalPurgePending(root, { wipe, log })).toBe(true);
      expect(await has(records, ra, wa)).toBe(false); expect(await has(creation, ra, wa)).toBe(false);
      expect(await has(records, rb, wb)).toBe(true); expect(readClinicalPurgePending(root)).toBeNull();
    } finally {
      clearClinicalPurgePending(root); await rm(root, { recursive: true, force: true });
    }
  });
});
