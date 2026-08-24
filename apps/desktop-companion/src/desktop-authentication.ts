import {
  createDesktopBrowserHandoff,
  parseDesktopAuthorizationCallback,
  parseDesktopLaunchUrl,
  validateDesktopAuthorizationCallback,
  type DesktopBrowserHandoff,
  type PendingDesktopAuthorization,
} from "./browser-handoff.js";
import type {
  DesktopApiClient,
  DesktopSessionCredential,
} from "./desktop-api.js";

/**
 * Authentication is an injected main-process boundary. Platform UI, identity
 * provider, and browser-flow revisions must not change capture authority or
 * lifecycle coordination.
 */
export interface DesktopAuthenticationPort {
  begin(
    launchUrl: string,
    installationSecret: string,
  ): DesktopBrowserHandoff;
  complete(
    callbackUrl: string,
    pending: PendingDesktopAuthorization,
    signal: AbortSignal,
  ): Promise<DesktopSessionCredential>;
}

/** Current platform-browser implementation of the replaceable auth boundary. */
export class PlatformDesktopAuthentication
  implements DesktopAuthenticationPort
{
  readonly #platformAppOrigin: string;
  readonly #api: DesktopApiClient;
  readonly #clock: () => Date;

  constructor(options: {
    readonly platformAppOrigin: string;
    readonly api: DesktopApiClient;
    readonly clock?: () => Date;
  }) {
    this.#platformAppOrigin = options.platformAppOrigin;
    this.#api = options.api;
    this.#clock = options.clock ?? (() => new Date());
  }

  begin(
    launchUrl: string,
    installationSecret: string,
  ): DesktopBrowserHandoff {
    return createDesktopBrowserHandoff(
      parseDesktopLaunchUrl(launchUrl),
      installationSecret,
      this.#platformAppOrigin,
      this.#clock(),
    );
  }

  complete(
    callbackUrl: string,
    pending: PendingDesktopAuthorization,
    signal: AbortSignal,
  ): Promise<DesktopSessionCredential> {
    const callback = parseDesktopAuthorizationCallback(callbackUrl);
    validateDesktopAuthorizationCallback(callback, pending, this.#clock());
    return this.#api.exchangeAuthorizationCode(
      {
        code: callback.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      },
      signal,
    );
  }
}
