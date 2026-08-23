import {
  createDesktopBrowserHandoff,
  parseDesktopAuthorizationCallback,
  parseDesktopLaunchUrl,
  validateDesktopAuthorizationCallback,
} from "./browser-handoff.js";
import { DesktopApiError } from "./desktop-api.js";
import type {
  DesktopApiClient,
  DesktopSessionCredential,
} from "./desktop-api.js";
import type { DesktopSecureStateStore } from "./secure-state-store.js";
import type { BackendCaptureGrant } from "./protocol.js";

export interface SystemBrowserPort {
  openExternal(url: string): Promise<void>;
}

export interface DesktopGrantInitializer {
  initialize(grant: BackendCaptureGrant, requestId: string): Promise<void>;
}

export class DesktopSessionError extends Error {
  readonly code:
    | "authorization_rejected"
    | "browser_unavailable"
    | "credential_unavailable";

  constructor(code: DesktopSessionError["code"]) {
    super("Desktop session operation failed");
    this.name = "DesktopSessionError";
    this.code = code;
  }
}

export class DesktopSessionCoordinator {
  readonly #platformAppOrigin: string;
  readonly #api: DesktopApiClient;
  readonly #store: DesktopSecureStateStore;
  readonly #browser: SystemBrowserPort;
  readonly #initializer: DesktopGrantInitializer;
  readonly #clock: () => Date;

  constructor(options: {
    readonly platformAppOrigin: string;
    readonly api: DesktopApiClient;
    readonly store: DesktopSecureStateStore;
    readonly browser: SystemBrowserPort;
    readonly initializer: DesktopGrantInitializer;
    readonly clock?: () => Date;
  }) {
    this.#platformAppOrigin = options.platformAppOrigin;
    this.#api = options.api;
    this.#store = options.store;
    this.#browser = options.browser;
    this.#initializer = options.initializer;
    this.#clock = options.clock ?? (() => new Date());
  }

  async handleLaunchUrl(value: string): Promise<void> {
    const launchTicket = parseDesktopLaunchUrl(value);
    const current = await this.#store.load();
    const handoff = createDesktopBrowserHandoff(
      launchTicket,
      current.installationSecret,
      this.#platformAppOrigin,
      this.#clock(),
    );
    await this.#store.update((state) => ({
      ...state,
      pendingAuthorization: handoff.pending,
      sessionCredential: null,
    }));
    try {
      await this.#browser.openExternal(handoff.connectUrl);
    } catch {
      await this.#store.update((state) => ({
        ...state,
        pendingAuthorization: null,
      }));
      throw new DesktopSessionError("browser_unavailable");
    }
  }

  async handleAuthorizationCallback(value: string): Promise<void> {
    const callback = parseDesktopAuthorizationCallback(value);
    const current = await this.#store.load();
    if (current.pendingAuthorization === null) {
      throw new DesktopSessionError("authorization_rejected");
    }
    try {
      validateDesktopAuthorizationCallback(
        callback,
        current.pendingAuthorization,
        this.#clock(),
      );
      const credential = await this.#api.exchangeAuthorizationCode(
        {
          code: callback.code,
          codeVerifier: current.pendingAuthorization.codeVerifier,
          redirectUri: current.pendingAuthorization.redirectUri,
        },
        new AbortController().signal,
      );
      await this.#store.update((state) => ({
        ...state,
        pendingAuthorization: null,
        sessionCredential: credential,
      }));
      await this.#initializer.initialize(
        credential.grant,
        `oauth.${callback.state.slice(0, 32)}`,
      );
    } catch (error) {
      await this.#store.update((state) => ({
        ...state,
        pendingAuthorization: null,
      }));
      if (error instanceof DesktopApiError && error.code === "unavailable") {
        throw new DesktopSessionError("credential_unavailable");
      }
      if (error instanceof DesktopSessionError) {
        throw error;
      }
      throw new DesktopSessionError("authorization_rejected");
    }
  }

  async credential(): Promise<DesktopSessionCredential> {
    const credential = (await this.#store.load()).sessionCredential;
    if (
      credential === null ||
      Date.parse(credential.expiresAt) <= this.#clock().getTime()
    ) {
      throw new DesktopSessionError("credential_unavailable");
    }
    return credential;
  }
}
