import { isAbsolute } from "node:path";

import {
  DESKTOP_CUSTOM_SCHEME,
  parseDesktopAuthorizationCallback,
  parseDesktopLaunchUrl,
} from "./browser-handoff.js";

export type DesktopDeepLink = Readonly<{
  kind: "launch" | "authorization_callback";
  url: string;
}>;

export interface DesktopDeepLinkSessionPort {
  handleLaunchUrl(url: string): Promise<void>;
  handleAuthorizationCallback(url: string): Promise<void>;
}

export interface ElectronProtocolClientPort {
  setAsDefaultProtocolClient(
    protocol: string,
    executablePath?: string,
    args?: string[],
  ): boolean;
}

export class DesktopDeepLinkError extends Error {
  constructor() {
    super("Desktop deep link was rejected");
    this.name = "DesktopDeepLinkError";
  }
}

export class DesktopDeepLinkRouter {
  readonly #session: DesktopDeepLinkSessionPort;
  readonly #enabled: boolean;
  readonly #activateWindow: () => void;

  constructor(options: {
    readonly session: DesktopDeepLinkSessionPort;
    readonly enabled: boolean;
    readonly activateWindow: () => void;
  }) {
    this.#session = options.session;
    this.#enabled = options.enabled;
    this.#activateWindow = options.activateWindow;
  }

  async route(value: string): Promise<"handled" | "feature_disabled"> {
    const target = parseDesktopDeepLink(value);
    this.#activateWindow();
    if (!this.#enabled) {
      return "feature_disabled";
    }
    if (target.kind === "launch") {
      await this.#session.handleLaunchUrl(target.url);
    } else {
      await this.#session.handleAuthorizationCallback(target.url);
    }
    return "handled";
  }
}

/**
 * Retains at most one validated pre-ready URL and never reports URL material in
 * errors. Event handlers intentionally enqueue without logging rejected work.
 */
export class DesktopDeepLinkIngress {
  #router: DesktopDeepLinkRouter | null = null;
  #pendingUrl: string | null = null;
  #work: Promise<void> = Promise.resolve();

  acceptUrl(value: string): boolean {
    let target: DesktopDeepLink;
    try {
      target = parseDesktopDeepLink(value);
    } catch {
      return false;
    }
    if (this.#router === null) {
      if (this.#pendingUrl === null) {
        this.#pendingUrl = target.url;
      }
      return true;
    }
    this.#enqueue(target.url);
    return true;
  }

  acceptCommandLine(commandLine: readonly string[]): boolean {
    let target: DesktopDeepLink | null;
    try {
      target = extractDesktopDeepLinkFromCommandLine(commandLine);
    } catch {
      return false;
    }
    return target === null ? false : this.acceptUrl(target.url);
  }

  connect(router: DesktopDeepLinkRouter): void {
    if (this.#router !== null) {
      throw new Error("Desktop deep-link ingress is already connected");
    }
    this.#router = router;
    if (this.#pendingUrl !== null) {
      const pendingUrl = this.#pendingUrl;
      this.#pendingUrl = null;
      this.#enqueue(pendingUrl);
    }
  }

  async settled(): Promise<void> {
    await this.#work;
  }

  #enqueue(url: string): void {
    const router = this.#router;
    if (router === null) {
      throw new Error("Desktop deep-link ingress is not connected");
    }
    const operation = this.#work.then(async () => {
      await router.route(url);
    });
    this.#work = operation.catch(() => undefined);
  }
}

export function parseDesktopDeepLink(value: string): DesktopDeepLink {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DesktopDeepLinkError();
  }
  try {
    if (parsed.hostname === "launch" && parsed.pathname === "") {
      parseDesktopLaunchUrl(value);
      return Object.freeze({ kind: "launch", url: value });
    }
    if (parsed.hostname === "oauth" && parsed.pathname === "/callback") {
      parseDesktopAuthorizationCallback(value);
      return Object.freeze({ kind: "authorization_callback", url: value });
    }
  } catch {
    throw new DesktopDeepLinkError();
  }
  throw new DesktopDeepLinkError();
}

export function extractDesktopDeepLinkFromCommandLine(
  commandLine: readonly string[],
): DesktopDeepLink | null {
  const candidates = commandLine.filter((argument) =>
    argument.toLowerCase().startsWith(`${DESKTOP_CUSTOM_SCHEME}:`),
  );
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length !== 1) {
    throw new DesktopDeepLinkError();
  }
  return parseDesktopDeepLink(candidates[0] ?? "");
}

export function registerDesktopProtocolClient(
  application: ElectronProtocolClientPort,
  options: {
    readonly isPackaged: boolean;
    readonly isDefaultApp: boolean;
    readonly executablePath: string;
    readonly entryScriptPath: string;
  },
): boolean {
  if (options.isPackaged) {
    return application.setAsDefaultProtocolClient(DESKTOP_CUSTOM_SCHEME);
  }
  if (
    !options.isDefaultApp ||
    !isAbsolute(options.executablePath) ||
    !isAbsolute(options.entryScriptPath)
  ) {
    return false;
  }
  return application.setAsDefaultProtocolClient(
    DESKTOP_CUSTOM_SCHEME,
    options.executablePath,
    [options.entryScriptPath],
  );
}
