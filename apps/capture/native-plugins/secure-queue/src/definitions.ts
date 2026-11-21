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
}

export interface SecureQueueAccountOptions {
  /** Core recoveryScope UUID (lowercase). */
  accountId: string;
  /** Optional ready-account correlation digest; never an authorization grant. */
  accountIdentitySHA256?: string;
}

export interface SecureQueueRememberedAccountResult {
  accountId: string | null;
  accountIdentitySHA256: string | null;
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
  /**
   * Legacy full-device clinical wipe. Account delete must use wipeAccount instead so
   * other accounts' queued items survive.
   */
  clearAll(): Promise<SecureQueueClearResult>;
  /** Per-account clinical wipe; returns remaining key count for that account (0 = empty). */
  wipeAccount(options: SecureQueueAccountOptions): Promise<SecureQueueClearResult>;
  /** Remember the signed-in recoveryScope for a later purge; claims legacy items to it. */
  rememberAccount(options: SecureQueueAccountOptions): Promise<void>;
  /** Attribute unkeyed legacy digests to accountId without deleting anything. */
  claimLegacyAccount(options: Pick<SecureQueueAccountOptions, "accountId">): Promise<void>;
  rememberedAccount(): Promise<SecureQueueRememberedAccountResult>;
  /** Idempotent migration of the pre-account queue; never drops records on failure. */
  migrateAccounts(): Promise<void>;
}
