import type { StandaloneProviderNative } from "./native-plugin";

type Configuration = Awaited<ReturnType<StandaloneProviderNative["getProviderConfiguration"]>>;
interface StartupHost {
  configuration(): Promise<Configuration>;
  application(): Promise<{ mount(root: HTMLElement, configuration: Configuration): () => Promise<void> }>;
}

/** Read-only startup. No workspace, session, recording or permission is opened
 * until both the packaged application and existing native configuration arrive. */
export function mountProviderStartup(root: HTMLElement, host: StartupHost): () => Promise<void> {
  let busy = false, closed = false, mounted = false;
  let closeApplication: (() => Promise<void>) | undefined;
  const show = (title: string, message: string, retry = false): void => {
    root.classList.add("provider-application");
    root.setAttribute("aria-busy", String(busy));
    // Fixed local text only; no native error/configuration is inserted into HTML.
    root.innerHTML = `<header class="provider-session-header"><strong>Cosmaneura Scribe</strong></header>
      <section class="provider-session-status" aria-live="polite"><h1>${title}</h1><p>${message}</p>
      ${retry ? '<button data-session-action="retry-startup">Retry opening Scribe</button>' : ""}</section>`;
  };
  const start = async (): Promise<void> => {
    if (busy || closed || mounted) return;
    busy = true;
    show("Opening Scribe", "Preparing your workspace…");
    try {
      const [configuration, application] = await Promise.all([host.configuration(), host.application()]);
      if (closed) return;
      if (!configuration.enabled) {
        busy = false;
        show("Setup required", "Scribe is not enabled for this build.");
        return;
      }
      const production = configuration.profile === "core-production-organization-v1"
        || configuration.profile === "core-production-personal-v1";
      if ((production ? configuration.coreOrigin !== "https://app.cosmaneura.com"
        : configuration.profile !== undefined || configuration.coreOrigin !== "https://staging-app.cosmaneura.com")
        || configuration.uploadOrigins.length !== 1
        || !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(configuration.uploadOrigins[0]!)) {
        throw new Error("provider_configuration_unavailable");
      }
      // Once mounting begins, an exception may leave an application owner.
      // Retrying setup is safe only before this boundary.
      mounted = true;
      root.removeEventListener("click", clicked);
      closeApplication = application.mount(root, configuration);
    } catch {
      if (!closed) {
        busy = false;
        show("Scribe could not open", mounted
          ? "Close Scribe and reopen it. Your saved recordings are retained."
          : "Try opening it again. Your saved recordings are retained.", !mounted);
      }
    } finally { busy = false; }
  };
  const clicked = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('[data-session-action="retry-startup"]')) void start();
  };
  root.addEventListener("click", clicked);
  void start();
  // Mark closed synchronously, including before a pending native read/import
  // finishes. A late reply cannot create an owner in a departed page.
  return async () => {
    closed = true;
    root.removeEventListener("click", clicked);
    await closeApplication?.();
  };
}
