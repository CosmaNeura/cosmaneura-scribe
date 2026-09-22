import type { PluginListenerHandle } from "@capacitor/core";
import { isUuid } from "../../../review-ui/src/contracts";
import { mountProviderWorkspace, type ProviderWorkspaceHost } from "./workspace";
import type { NativeProviderSession, ProviderSessionPhase, ProviderSessionState } from "./native-plugin";
import "./application.css";

export type { ProviderSessionState } from "./native-plugin";
export interface ProviderApplicationHost {
  readonly session: NativeProviderSession;
  /** Returns the current authorized provider workflow, never credentials. */
  connect(signal: AbortSignal): Promise<{ readonly workspace: ProviderWorkspaceHost; dispose(): Promise<void> }>;
}
interface Scope {
  readonly abort: AbortController;
  readonly revision: string;
  connecting: Promise<void>;
  connection?: Awaited<ReturnType<ProviderApplicationHost["connect"]>>;
  unmount?: () => Promise<void>;
  close?: Promise<void>;
}

/** Own the standalone app's visible session and complete provider workspace.
 * Authentication policy remains in the native session owner. UI access closes
 * immediately on logout/revision change, while recorder ownership survives an
 * unconfirmed stop so it can be retried instead of opening a second recorder.
 */
export function mountProviderApplication(root: HTMLElement, host: ProviderApplicationHost): () => Promise<void> {
  let state: ProviderSessionState | null = null, observations = 0;
  let scope: Scope | undefined, listener: PluginListenerHandle | undefined;
  let disposed = false, busy = false, stopUnconfirmed = false, accessClosed = false, logoutPending = false;
  let operations = 0, signingOut = false;
  let recorderStopUnconfirmed = false;
  let notice = "", polling: Promise<void> | undefined, disposal: Promise<void> | undefined;
  root.classList.add("provider-application");
  root.innerHTML = `<header class="provider-session-header"><strong>Cosmaneura Scribe</strong><div data-session-actions></div></header>
    <section class="provider-session-status" aria-live="polite"><h1 data-session-title></h1><p data-session-message></p>
    <div data-session-recovery></div></section><main data-provider-workflow></main>`;
  const actions = root.querySelector<HTMLElement>("[data-session-actions]")!;
  const title = root.querySelector<HTMLElement>("[data-session-title]")!;
  const message = root.querySelector<HTMLElement>("[data-session-message]")!;
  const recovery = root.querySelector<HTMLElement>("[data-session-recovery]")!;
  const workflow = root.querySelector<HTMLElement>("[data-provider-workflow]")!;
  const button = (action: string, label: string): string => `<button data-session-action="${action}"${(action === "sign-out" ? signingOut : busy) ? " disabled" : ""}>${label}</button>`;
  const render = (): void => {
    if (disposed) return;
    const phase = state?.phase ?? (notice ? "unavailable" : "loading");
    const shown: Record<ProviderSessionPhase, [string, string]> = {
      disabled: ["Setup required", "This installation has not been connected to your practice."],
      loading: ["Opening Scribe", "Checking your secure session…"],
      signedOut: ["Welcome to Scribe", "Sign in to record, review and continue your encounter notes."],
      signingIn: ["Complete sign-in", "Finish signing in using the secure sign-in window."],
      ready: [scope?.unmount && !scope.abort.signal.aborted ? "" : "Your workspace", ""],
      signOutPending: ["Sign-out needs attention", "Your workspace is closed. Retry sign-out to finish."],
      unavailable: ["Session unavailable", "Your workspace is closed. Check the session to continue."],
    };
    [title.textContent, message.textContent] = shown[phase];
    if (notice) message.textContent = notice;
    actions.innerHTML = phase === "ready" || phase === "signingIn" ? button("sign-out", "Sign out") : "";
    recovery.innerHTML = "";
    if (stopUnconfirmed) {
      title.textContent = recorderStopUnconfirmed ? "Recording stop needs attention" : "Workspace close needs attention";
      message.textContent = recorderStopUnconfirmed
        ? "Recording stop could not be confirmed. Retry stopping it before reopening your workspace. Your saved work is retained."
        : "Your workspace could not finish closing. Retry closing it before continuing. Your saved work is retained.";
      recovery.innerHTML = button("stop", recorderStopUnconfirmed ? "Retry stopping recorder" : "Retry closing workspace");
    } else if (logoutPending) {
      title.textContent = "Sign-out needs attention";
      message.textContent = "Your workspace is closed. Retry sign-out to finish.";
      recovery.innerHTML = button("sign-out", "Retry sign out");
    } else if (phase === "signedOut") recovery.innerHTML = button("sign-in", "Sign in");
    else if (phase === "signOutPending") recovery.innerHTML = button("sign-out", "Retry sign out");
    else if (phase === "unavailable" || phase === "disabled") recovery.innerHTML = button("check", "Check session");
    else if (phase === "ready" && (!scope || scope.abort.signal.aborted)) {
      recovery.innerHTML = button("open", "Open workspace");
    }
    root.setAttribute("aria-busy", String(busy));
  };
  const invalidate = (): void => {
    scope?.abort.abort();
    workflow.replaceChildren(); // Clear clinical content before awaiting native I/O.
  };
  const close = async (): Promise<void> => {
    const owned = scope;
    if (!owned) return;
    invalidate();
    const closing = owned.close ??= (async () => {
      await owned.connecting; // A late connection still belongs to this scope.
      try { await owned.unmount?.(); recorderStopUnconfirmed = false; }
      catch { recorderStopUnconfirmed = true; throw new Error("provider_recorder_stop_unconfirmed"); }
      await owned.connection?.dispose();
      if (scope === owned) scope = undefined;
      stopUnconfirmed = false;
    })();
    try { await closing; }
    catch { delete owned.close; stopUnconfirmed = true; throw new Error("provider_close_unconfirmed"); }
  };
  const closeInBackground = (): void => {
    void close().catch(() => undefined).finally(render);
  };
  const accept = (value: ProviderSessionState): void => {
    if (disposed) return;
    observations += 1;
    const valid = value && ["disabled", "loading", "signedOut", "signingIn", "ready", "signOutPending", "unavailable"].includes(value.phase)
      && isUuid(value.revision);
    if (!valid) {
      state = null; accessClosed = true; notice = "Your secure session could not be verified.";
      invalidate(); closeInBackground(); render(); return;
    }
    const changed = state?.revision !== value.revision || state.phase !== value.phase;
    state = { phase: value.phase, revision: value.revision };
    if (value.phase === "signedOut") logoutPending = false;
    if (value.phase === "signOutPending") logoutPending = true;
    if (scope && (value.phase !== "ready" || value.revision !== scope.revision)) {
      accessClosed = true; invalidate(); closeInBackground();
    }
    if (changed) notice = "";
    render();
  };
  const read = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    return polling ??= (async () => {
      const before = observations;
      try {
        const value = await host.session.getState();
        if (!disposed && before === observations) accept(value);
      } catch {
        if (!disposed && before === observations) {
          state = null;
          accessClosed = true; invalidate(); closeInBackground();
          notice = "Your secure session could not be checked. Your workspace is closed.";
          render();
        }
      } finally { polling = undefined; }
    })();
  };
  const open = async (): Promise<void> => {
    await close();
    await read();
    if (disposed || !listener || logoutPending || state?.phase !== "ready") return;
    const owned: Scope = { abort: new AbortController(), revision: state.revision, connecting: Promise.resolve() };
    scope = owned; accessClosed = false;
    notice = "Connecting your workspace…"; render();
    owned.connecting = Promise.resolve().then(async () => {
      try {
        const connection = await host.connect(owned.abort.signal);
        owned.connection = connection;
        if (disposed || owned.abort.signal.aborted || state?.phase !== "ready" || state.revision !== owned.revision) return;
        if (connection.workspace.signal.aborted) throw new Error("provider_connection_closed");
        connection.workspace.signal.addEventListener("abort", () => {
          if (scope !== owned || owned.abort.signal.aborted) return;
          accessClosed = true; notice = "Your workspace connection closed. Check your session and reopen to continue.";
          invalidate(); closeInBackground(); render();
        }, { once: true });
        owned.unmount = mountProviderWorkspace(workflow, connection.workspace);
        notice = "";
      } catch {
        owned.abort.abort(); accessClosed = true;
        notice = "Your workspace could not be opened. Check your connection and try again.";
      }
    });
    await owned.connecting;
    if (owned.abort.signal.aborted) await close();
    render();
  };
  const perform = async (action: string): Promise<void> => {
    if (disposed || (action === "sign-out" ? signingOut : busy)) return;
    operations += 1; busy = true;
    if (action === "sign-out") signingOut = true;
    notice = ""; render();
    try {
      if (action === "sign-out") {
        logoutPending = true;
        accessClosed = true; invalidate();
        // Persist native logout intent even if the recorder's stop fails. A
        // failed cleanup must never leave the native session silently signed in.
        const before = observations;
        const signingOut = host.session.signOut();
        const closing = close();
        const results = await Promise.allSettled([signingOut, closing]);
        if (results[0].status === "fulfilled") {
          if (before === observations) accept(results[0].value);
        } else notice = "Sign-out could not be confirmed. Check the session and retry sign-out.";
        if (results[1].status === "rejected") stopUnconfirmed = true;
        await read();
      } else if (action === "stop") {
        await close();
      } else if (action === "sign-in") {
        await close();
        const before = observations;
        const value = await host.session.signIn();
        if (before === observations) accept(value);
        await read();
        if (state?.phase === "ready") await open();
      } else if (action === "open") await open();
      else if (action === "check") await read();
    } catch {
      if (!stopUnconfirmed) notice = "This action could not be confirmed. Check your session and try again.";
    } finally {
      operations -= 1; busy = operations > 0;
      if (action === "sign-out") signingOut = false;
      render();
    }
  };
  const clicked = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLButtonElement>("button[data-session-action]")?.dataset.sessionAction;
    if (action) void perform(action);
  };
  const resume = (): void => { if (document.visibilityState === "visible") void read(); };
  const sessionState = (): ProviderSessionState | null => state;
  root.addEventListener("click", clicked);
  document.addEventListener("visibilitychange", resume);
  const timer = setInterval(() => { void read(); }, 5000); // Native state only, never a token.
  render();
  const starting = (async () => {
    try {
      const added = await host.session.addListener("authStateChanged", accept);
      if (disposed) { await added.remove(); return; }
      listener = added;
      await read();
      // Restored sign-in opens once. A revoked or closed connection always
      // requires an explicit reopen, including a later identical ready state.
      if (!disposed && !accessClosed && sessionState()?.phase === "ready") await perform("open");
    } catch {
      notice = "The native session is unavailable. Reopen Scribe to try again.";
      accessClosed = true; render();
    }
  })();
  return (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true; invalidate(); clearInterval(timer);
    root.removeEventListener("click", clicked);
    document.removeEventListener("visibilitychange", resume);
    disposal = (async () => {
      try { await starting; await close(); await listener?.remove(); root.replaceChildren(); }
      catch { disposal = undefined; throw new Error("provider_close_unconfirmed"); }
    })();
    return disposal;
  };
}
