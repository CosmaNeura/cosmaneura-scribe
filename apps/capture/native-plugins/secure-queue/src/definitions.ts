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
  put(options: SecureQueueRecord): Promise<SecureQueueRevisionResult>;
  create(options: SecureQueueRecord): Promise<SecureQueueRevisionResult>;
  get(options: SecureQueueKeyOptions): Promise<VersionedSecureQueueRecord>;
  list(): Promise<SecureQueueListResult>;
  compareAndSwap(
    options: SecureQueueCompareAndSwapOptions,
  ): Promise<SecureQueueRevisionResult>;
  delete(options: SecureQueueKeyOptions): Promise<SecureQueueDeleteResult>;
  clear(): Promise<SecureQueueClearResult>;
}
