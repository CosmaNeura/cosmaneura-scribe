/** Standard, padded Base64 containing one opaque queue record. */
export interface SecureQueueRecord {
  key: string;
  data: string;
}

export interface VersionedSecureQueueRecord extends SecureQueueRecord {
  /** Opaque canonical decimal string; callers must not perform arithmetic on it. */
  revision: string;
}

export interface SecureQueueKeyOptions {
  key: string;
}

export interface SecureQueueListResult {
  keys: string[];
}

export interface SecureQueueDeleteResult {
  deleted: boolean;
}

export interface SecureQueueClearResult {
  cleared: number;
  remaining?: number;
}

export interface SecureQueueAccountOptions {
  accountId: string;
  accountIdentitySHA256?: string;
}

export interface SecureQueueRememberedAccountResult {
  accountId: string | null;
  accountIdentitySHA256: string | null;
}

export interface SecureQueueRememberedAccountOptions {
  accountIdentitySHA256?: string;
}

export interface SecureQueueRevisionResult {
  revision: string;
}

export interface SecureQueueCompareAndSwapOptions extends SecureQueueRecord {
  expectedRevision: string;
}

/**
 * Device-only encrypted record storage for the packaged iOS and Android apps.
 *
 * The native storage key never enters this interface. This plugin intentionally
 * has no web implementation; the PWA has a separate custody profile.
 */
export interface SecureQueuePlugin {
  /** Current free space on the queue volume, as a canonical nonnegative decimal. */
  getStorageCapacity(): Promise<{ availableBytes: string }>;
  put(options: SecureQueueRecord): Promise<SecureQueueRevisionResult>;
  create(options: SecureQueueRecord): Promise<SecureQueueRevisionResult>;
  get(options: SecureQueueKeyOptions): Promise<VersionedSecureQueueRecord>;
  list(): Promise<SecureQueueListResult>;
  compareAndSwap(
    options: SecureQueueCompareAndSwapOptions,
  ): Promise<SecureQueueRevisionResult>;
  delete(options: SecureQueueKeyOptions): Promise<SecureQueueDeleteResult>;
  /** Renderer-only clear; refuses when native recording keys exist. */
  clear(): Promise<SecureQueueClearResult>;
  clearAll(): Promise<SecureQueueClearResult>;
  wipeAccount(options: SecureQueueAccountOptions): Promise<SecureQueueClearResult>;
  rememberAccount(options: SecureQueueAccountOptions): Promise<void>;
  setActiveWriteAccount(
    options: { accountId: string | null; ifMatches?: string },
  ): Promise<void>;
  claimLegacyAccount(options: Pick<SecureQueueAccountOptions, "accountId">): Promise<void>;
  rememberedAccount(
    options?: SecureQueueRememberedAccountOptions,
  ): Promise<SecureQueueRememberedAccountResult>;
  migrateAccounts(): Promise<void>;
}
