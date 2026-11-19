import { describe, expect, it } from "vitest";
import {
  CLINICAL_KEY_PREFIXES, CLINICAL_STORE_NAMES, clinicalStoresFromKeys,
  deleteProviderFlowDatabases, purgeLocalClinicalData, type ClinicalStoreName,
} from "./purge-local-clinical";

describe("purgeLocalClinicalData", () => {
  it("empties journal, drafts, review, queued audio, and recordings", async () => {
    const bags = Object.fromEntries(CLINICAL_STORE_NAMES.map(name => [name, [
      `${CLINICAL_KEY_PREFIXES[name][0]}synthetic`,
    ]])) as Record<ClinicalStoreName, string[]>;
    const stores = clinicalStoresFromKeys({
      list: async () => CLINICAL_STORE_NAMES.flatMap(name => bags[name]),
      delete: async key => {
        for (const name of CLINICAL_STORE_NAMES) bags[name] = bags[name].filter(entry => entry !== key);
      },
      clearAll: async () => { for (const name of CLINICAL_STORE_NAMES) bags[name] = []; },
    });
    await purgeLocalClinicalData(stores);
    for (const name of CLINICAL_STORE_NAMES) {
      expect(bags[name]).toEqual([]);
      expect(await stores[name].isEmpty()).toBe(true);
    }
  });

  it("throws when a store remains non-empty after clear", async () => {
    const empty = { clear: async () => undefined, isEmpty: async () => true };
    await expect(purgeLocalClinicalData({
      journal: { clear: async () => undefined, isEmpty: async () => false },
      drafts: empty, review: empty, queuedAudio: empty, recordings: empty,
    })).rejects.toThrow(/clinical_store_not_empty:journal/);
  });

});

describe("deleteProviderFlowDatabases", () => {
  it("deletes only scribe-provider-flow IndexedDB databases", async () => {
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
  });
});
