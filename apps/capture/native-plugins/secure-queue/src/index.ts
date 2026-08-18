import { registerPlugin } from "@capacitor/core";

import type { SecureQueuePlugin } from "./definitions.js";

export type {
  SecureQueueClearResult,
  SecureQueueCompareAndSwapOptions,
  SecureQueueDeleteResult,
  SecureQueueKeyOptions,
  SecureQueueListResult,
  SecureQueuePlugin,
  SecureQueueRecord,
  SecureQueueRevisionResult,
  VersionedSecureQueueRecord,
} from "./definitions.js";

export const SecureQueue = registerPlugin<SecureQueuePlugin>("SecureQueue");
