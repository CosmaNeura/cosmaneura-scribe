
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

const ACCOUNT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** recoveryScope embedded in known clinical / native key shapes. */
export function clinicalAccountIdFromKey(key: string): string | null {
  const parts = key.split(":");
  const uuid = (index: number): string | null => {
    const value = parts[index]?.toLowerCase();
    return value && ACCOUNT_UUID.test(value) ? value : null;
  };
  switch (parts[0]) {
    case "provider-workspace-v1":
    case "creator-transcript-edit-v1":
    case "creator-review-v1":
    case "provider-encounter-creation-v1":
    case "provider-hidden-visits-v1":
    case "provider-patient-match-v1":
      return uuid(1);
    case "scribe-provider-queue":
      return parts[1] === "v1" ? uuid(2) : null;
    case "scribe-native-flow":
    case "scribe-native-reservations":
    case "scribe-native-initial-window":
    case "scribe-native-resume-window":
      return parts[1] === "v1" ? uuid(3) : null;
    default:
      return null;
  }
}

export function clinicalStoresFromKeys(
  keys: {
    list(): Promise<readonly string[]>;
    delete(key: string): Promise<void>;
    clearAll?: () => Promise<number>;
    /** When set, empty checks only consider this account's keys (per-account wipe). */
    accountId?: string;
  },
): LocalClinicalStores {
  let cleared = false;
  const accountId = keys.accountId?.toLowerCase();
  if (accountId && !ACCOUNT_UUID.test(accountId)) throw new Error("clinical_account_unavailable");
  /** Parseable account match only. Unowned clinical residue is counted by wipeAccount
   * remaining (H1); opaque digests owned by another account are invisible here. */
  const matchesAccount = (key: string): boolean => {
    if (!accountId) return true;
    return clinicalAccountIdFromKey(key) === accountId;
  };
  const wipe = async (): Promise<void> => {
    if (cleared) return;
    if (keys.clearAll) {
      const remaining = await keys.clearAll();
      if (remaining !== 0) throw new Error(`clinical_clear_all_remaining:${remaining}`);
    } else {
      for (const key of await keys.list()) {
        if (matchesAccount(key)) await keys.delete(key);
      }
    }
    cleared = true;
  };
  const empty = (prefixes: readonly string[]) => async (): Promise<boolean> => {
    const remaining = (await keys.list()).filter(key =>
      prefixes.some(prefix => key.startsWith(prefix)) && matchesAccount(key));
    return remaining.length === 0;
  };
  const store = (prefixes: readonly string[]): ClinicalStore => ({ clear: wipe, isEmpty: empty(prefixes) });
  return Object.fromEntries(CLINICAL_STORE_NAMES.map(n => [n, store(CLINICAL_KEY_PREFIXES[n])])) as LocalClinicalStores;
}

export async function deleteProviderFlowDatabases(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  // H8: missing databases() is a failure; blocked delete is a failure.
  if (!factory || typeof factory.databases !== "function") {
    throw new Error("clinical_idb_databases_unsupported");
  }
  const rows = await factory.databases();
  await Promise.all(rows.filter(row => typeof row.name === "string"
    && row.name.startsWith("scribe-provider-flow:v1:")).map(row => new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(row.name!);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("idb_delete_failed"));
    request.onblocked = () => reject(new Error("idb_delete_blocked"));
  })));
}

export async function purgeLocalClinicalWithFlowDatabases(
  hostPurge: () => Promise<void>,
  factory?: IDBFactory,
): Promise<void> {
  const results = await Promise.allSettled([hostPurge(), deleteProviderFlowDatabases(factory)]);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason instanceof Error ? failed.reason : new Error("clinical_purge_failed");
  }
}
