import { describe, expect, it } from "vitest";
import {
  CLINICAL_KEY_PREFIXES, CLINICAL_STORE_NAMES, clinicalAccountIdFromKey,
  clinicalStoresFromKeys, deleteProviderFlowDatabases, purgeLocalClinicalData, type ClinicalStoreName,
} from "./purge-local-clinical";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const accountA = "11111111-1111-4111-8111-111111111111";
const accountB = "22222222-2222-4222-8222-222222222222";
const workspace = "33333333-3333-4333-8333-333333333333";
const session = "44444444-4444-4444-8444-444444444444";

describe("purgeLocalClinicalData", () => {
  it("empties clinical stores; throws when a store remains non-empty", async () => {
    const bags = Object.fromEntries(CLINICAL_STORE_NAMES.map(name => [name, [
      `${CLINICAL_KEY_PREFIXES[name][0]}synthetic`,
    ]])) as Record<ClinicalStoreName, string[]>;
    const stores = clinicalStoresFromKeys({
      list: async () => CLINICAL_STORE_NAMES.flatMap(name => bags[name]),
      delete: async key => {
        for (const name of CLINICAL_STORE_NAMES) bags[name] = bags[name].filter(entry => entry !== key);
      },
      clearAll: async () => { for (const name of CLINICAL_STORE_NAMES) bags[name] = []; return 0; },
    });
    await purgeLocalClinicalData(stores);
    for (const name of CLINICAL_STORE_NAMES) {
      expect(bags[name]).toEqual([]); expect(await stores[name].isEmpty()).toBe(true);
    }
    await expect(clinicalStoresFromKeys({
      list: async () => ["provider-workspace-v1:x"], delete: async () => undefined,
      clearAll: async () => 1,
    }).journal.clear()).rejects.toThrow(/clinical_clear_all_remaining:1/);
    const empty = { clear: async () => undefined, isEmpty: async () => true };
    await expect(purgeLocalClinicalData({
      journal: { clear: async () => undefined, isEmpty: async () => false },
      drafts: empty, review: empty, queuedAudio: empty, recordings: empty,
    })).rejects.toThrow(/clinical_store_not_empty:journal/);
  });

  it("per-account wipe of A leaves B's clinical keys", async () => {
    expect(clinicalAccountIdFromKey(`scribe-provider-queue:v1:${accountA}:${workspace}:${session}:q`))
      .toBe(accountA);
    const keys = [
      `scribe-provider-queue:v1:${accountA}:${workspace}:${session}:a`,
      `scribe-provider-queue:v1:${accountB}:${workspace}:${session}:b`,
      `provider-workspace-v1:${accountA}:${workspace}`,
      `provider-workspace-v1:${accountB}:${workspace}`,
    ];
    let wiped = false;
    const stores = clinicalStoresFromKeys({
      accountId: accountA,
      list: async () => keys,
      delete: async key => {
        const index = keys.indexOf(key);
        if (index >= 0) keys.splice(index, 1);
      },
      clearAll: async () => {
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          if (clinicalAccountIdFromKey(keys[index]!) === accountA) keys.splice(index, 1);
        }
        wiped = true;
        return keys.filter(key => clinicalAccountIdFromKey(key) === accountA).length;
      },
    });
    await purgeLocalClinicalData(stores);
    expect(wiped).toBe(true);
    expect(keys).toEqual([
      `scribe-provider-queue:v1:${accountB}:${workspace}:${session}:b`,
      `provider-workspace-v1:${accountB}:${workspace}`,
    ]);
    expect(await stores.queuedAudio.isEmpty()).toBe(true);
    expect(await stores.journal.isEmpty()).toBe(true);
  });

  it("shared fixture: clinicalAccountIdFromKey matches owner; clinical field asserted", () => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../native-plugins/secure-queue/fixtures/clinical-key-shapes.json",
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      tenant: string;
      shapes: Array<{ key: string; owner: string | null; clinical: boolean }>;
    };
    expect(fixture.tenant).toBe("55555555-5555-4555-8555-555555555555");
    expect(fixture.shapes).toHaveLength(16);
    for (const shape of fixture.shapes) {
      expect(clinicalAccountIdFromKey(shape.key)).toBe(shape.owner);
      expect(shape.clinical).toBe(shape.key !== "legacy-unkeyed-record");
    }
  });

  it("H8: IDB delete rejects blocked/unsupported; allSettled throws", async () => {
    const deleted: string[] = [];
    await deleteProviderFlowDatabases({
      databases: async () => [
        { name: "scribe-provider-flow:v1:a" }, { name: "other" }, { name: "scribe-provider-flow:v1:b" },
      ],
      deleteDatabase: (name: string) => {
        deleted.push(name);
        return {
          set onsuccess(h: () => void) { queueMicrotask(h); },
          set onerror(_h: () => void) {}, set onblocked(_h: () => void) {}, error: null,
        };
      },
    } as unknown as IDBFactory);
    expect(deleted).toEqual(["scribe-provider-flow:v1:a", "scribe-provider-flow:v1:b"]);
    await expect(deleteProviderFlowDatabases(undefined)).rejects.toThrow(/clinical_idb_databases_unsupported/);
    await expect(deleteProviderFlowDatabases({
      databases: async () => [{ name: "scribe-provider-flow:v1:z" }],
      deleteDatabase: () => ({
        set onsuccess(_h: () => void) {}, set onerror(_h: () => void) {},
        set onblocked(h: () => void) { queueMicrotask(h); }, error: null,
      }),
    } as unknown as IDBFactory)).rejects.toThrow(/idb_delete_blocked/);
    const { purgeLocalClinicalWithFlowDatabases } = await import("./purge-local-clinical");
    await expect(purgeLocalClinicalWithFlowDatabases(
      async () => undefined, undefined,
    )).rejects.toThrow(/clinical_idb_databases_unsupported/);
  });
});
