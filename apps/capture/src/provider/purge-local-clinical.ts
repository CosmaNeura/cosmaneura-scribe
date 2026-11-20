/** Wipe local clinical custody after Cosmas account delete ("Clearing this device"). */

export type ClinicalStoreName = "journal" | "drafts" | "review" | "queuedAudio" | "recordings";
export interface ClinicalStore { clear(): Promise<void>; isEmpty(): Promise<boolean>; }
export type LocalClinicalStores = Record<ClinicalStoreName, ClinicalStore>;
export const CLINICAL_STORE_NAMES: readonly ClinicalStoreName[] = [
  "journal", "drafts", "review", "queuedAudio", "recordings",
] as const;
export const CLINICAL_KEY_PREFIXES: Record<ClinicalStoreName, readonly string[]> = {
  journal: ["provider-workspace-v1:"], drafts: ["creator-transcript-edit-v1:"],
  review: ["creator-review-v1:"], queuedAudio: ["scribe-provider-queue:v1:"],
  recordings: ["scribe-native-"],
};

export async function purgeLocalClinicalData(stores: LocalClinicalStores): Promise<void> {
  for (const name of CLINICAL_STORE_NAMES) await stores[name].clear();
  for (const name of CLINICAL_STORE_NAMES) {
    if (!(await stores[name].isEmpty())) throw new Error(`clinical_store_not_empty:${name}`);
  }
}

/** Shared-map adapter; clearAll wipes native keys that renderer list() cannot see. */
export function clinicalStoresFromKeys(
  keys: { list(): Promise<readonly string[]>; delete(key: string): Promise<void>; clearAll?: () => Promise<void> },
): LocalClinicalStores {
  let cleared = false;
  const wipe = async (): Promise<void> => {
    if (cleared) return;
    if (keys.clearAll) await keys.clearAll();
    else for (const key of await keys.list()) await keys.delete(key);
    cleared = true;
  };
  const empty = (prefixes: readonly string[]) => async (): Promise<boolean> => {
    if (cleared && keys.clearAll) return true;
    return !(await keys.list()).some(key => prefixes.some(prefix => key.startsWith(prefix)));
  };
  const store = (prefixes: readonly string[]): ClinicalStore => ({ clear: wipe, isEmpty: empty(prefixes) });
  return {
    journal: store(CLINICAL_KEY_PREFIXES.journal), drafts: store(CLINICAL_KEY_PREFIXES.drafts),
    review: store(CLINICAL_KEY_PREFIXES.review), queuedAudio: store(CLINICAL_KEY_PREFIXES.queuedAudio),
    recordings: store(CLINICAL_KEY_PREFIXES.recordings),
  };
}

export async function deleteProviderFlowDatabases(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory || typeof factory.databases !== "function") return;
  const rows = await factory.databases();
  await Promise.all(rows.filter(row => typeof row.name === "string"
    && row.name.startsWith("scribe-provider-flow:v1:")).map(row => new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(row.name!);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("idb_delete_failed"));
    request.onblocked = () => resolve();
  })));
}
