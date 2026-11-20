import { describe, expect, it } from "vitest";
import {
  CLINICAL_KEY_PREFIXES, CLINICAL_STORE_NAMES, clinicalStoresFromKeys,
  deleteProviderFlowDatabases, purgeLocalClinicalData, type ClinicalStoreName,
} from "./purge-local-clinical";

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
