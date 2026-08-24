import { DesktopApiError } from "./desktop-api.js";
import type { DesktopSessionCredential } from "./desktop-api.js";
import type { DesktopAuthenticationPort } from "./desktop-authentication.js";
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
  readonly #authentication: DesktopAuthenticationPort;
  readonly #store: DesktopSecureStateStore;
  readonly #browser: SystemBrowserPort;
  readonly #initializer: DesktopGrantInitializer;
  readonly #clock: () => Date;

  constructor(options: {
    readonly authentication: DesktopAuthenticationPort;
    readonly store: DesktopSecureStateStore;
    readonly browser: SystemBrowserPort;
    readonly initializer: DesktopGrantInitializer;
    readonly clock?: () => Date;
  }) {
    this.#authentication = options.authentication;
    this.#store = options.store;
    this.#browser = options.browser;
    this.#initializer = options.initializer;
    this.#clock = options.clock ?? (() => new Date());
  }

  async handleLaunchUrl(value: string): Promise<void> {
    const current = await this.#store.load();
    const handoff = this.#authentication.begin(
      value,
      current.installationSecret,
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
    const current = await this.#store.load();
    if (current.pendingAuthorization === null) {
      throw new DesktopSessionError("authorization_rejected");
    }
    try {
      const credential = await this.#authentication.complete(
        value,
        current.pendingAuthorization,
        new AbortController().signal,
      );
      await this.#store.update((state) => ({
        ...state,
        pendingAuthorization: null,
        sessionCredential: credential,
      }));
      await this.#initializer.initialize(
        credential.grant,
        `oauth.${current.pendingAuthorization.state.slice(0, 32)}`,
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
