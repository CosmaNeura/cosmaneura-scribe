import { generateOpaqueSecret } from "./browser-handoff.js";
import type { DesktopCaptureAdapter } from "./capture-adapter.js";
import { DesktopCaptureController } from "./controller.js";
import {
  DesktopApiClient,
  PlatformDesktopCaptureAuthority,
} from "./desktop-api.js";
import {
  PlatformDesktopAuthentication,
  type DesktopAuthenticationPort,
} from "./desktop-authentication.js";
import { DesktopLifecycleCoordinator } from "./desktop-lifecycle.js";
import {
  DesktopSessionCoordinator,
  type SystemBrowserPort,
} from "./desktop-session.js";
import type { PersistentRecordingIndicator } from "./recording-indicator.js";
import {
  DesktopSecureStateStore,
  NodeEncryptedStateFile,
  type ElectronSafeStoragePort,
  type EncryptedStateFilePort,
} from "./secure-state-store.js";

export interface TrustedDesktopRuntime {
  readonly controller: DesktopCaptureController;
  readonly lifecycle: DesktopLifecycleCoordinator;
  readonly session: DesktopSessionCoordinator;
  readonly store: DesktopSecureStateStore;
}

/**
 * Compose the main-process-only desktop boundary. The caller still owns the
 * compile-time release gate, Electron deep-link registration, and SDK loading.
 */
export function createTrustedDesktopRuntime(options: {
  readonly platformAppOrigin: string;
  readonly platformApiOrigin: string;
  readonly adapter: DesktopCaptureAdapter;
  readonly indicator: PersistentRecordingIndicator;
  readonly safeStorage: ElectronSafeStoragePort;
  readonly protectedStateDirectory: string;
  readonly browser: SystemBrowserPort;
  readonly authentication?: DesktopAuthenticationPort;
  readonly enabled: boolean;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
  readonly encryptedStateFile?: EncryptedStateFilePort;
  readonly allowInsecureLoopback?: boolean;
}): TrustedDesktopRuntime {
  const clock = options.clock ?? (() => new Date());
  const store = new DesktopSecureStateStore(
    options.safeStorage,
    options.encryptedStateFile ??
      new NodeEncryptedStateFile(options.protectedStateDirectory),
  );
  const api = new DesktopApiClient(options.platformApiOrigin, {
    clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  });
  const lifecycle = new DesktopLifecycleCoordinator({
    api,
    store,
    clock,
    idempotencyKey: (operation) => `${operation}.${generateOpaqueSecret()}`,
  });
  const authentication =
    options.authentication ??
    new PlatformDesktopAuthentication({
      platformAppOrigin: options.platformAppOrigin,
      api,
      clock,
    });

  let session: DesktopSessionCoordinator | null = null;
  const authority = new PlatformDesktopCaptureAuthority(
    api,
    async () => {
      if (session === null) {
        throw new Error("Desktop session is not initialized");
      }
      return session.credential();
    },
    () => `start.${generateOpaqueSecret()}`,
  );
  const controller = new DesktopCaptureController(
    options.adapter,
    options.indicator,
    {
      enabled: options.enabled,
      authority,
      lifecycle,
      clock,
    },
  );
  session = new DesktopSessionCoordinator({
    authentication,
    store,
    browser: options.browser,
    initializer: {
      initialize: (grant, requestId) =>
        controller.initializeFromBackend(grant, requestId),
    },
    clock,
  });
  return Object.freeze({ controller, lifecycle, session, store });
}
