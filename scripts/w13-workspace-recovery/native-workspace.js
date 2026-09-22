/* global document, window */
// Applied only to the hash-verified, retained W13 web asset. The native SDK,
// Keychain, token policy and API authorization are not changed by this adapter.
export function createWorkspaceRecovery({ React, jsx, WorkspaceAuth, availableByDefault,
  StatusScreen, EncounterWorkspace, parseState, parseToken, sameState }) {
  return function NativeAuthenticatedWorkspace({ plugin = WorkspaceAuth,
    available = availableByDefault(), createIdentity }) {
    const [state, setState] = React.useState(null);
    const [failed, setFailed] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    // Keep this outside the revision-keyed workspace: a failed token request
    // can close the workspace and the following SDK state read can reopen it.
    const [accessFailed, setAccessFailed] = React.useState(false);
    const session = React.useRef(null);
    const identity = React.useMemo(() => {
      if (state?.phase !== "ready" || !state.identity) return null;
      const scope = session.current;
      const expected = state;
      const stillCurrent = () => Boolean(scope?.active && !scope.pending && session.current === scope &&
        scope.current && sameState(scope.current, expected));
      async function getToken() {
        try {
          if (!stillCurrent()) throw new Error();
          const result = await plugin.getToken({ expectedRevision: expected.revision });
          if (!stillCurrent()) throw new Error();
          const token = parseToken(result, expected.revision);
          setAccessFailed(false);
          return token;
        } catch {
          // An abandoned request must not affect a replacement adapter/account.
          if (scope?.active && !scope.pending && session.current === scope &&
              (!scope.current?.identity || sameAccount(scope.current, expected))) setAccessFailed(true);
          throw new Error("Native session unavailable");
        }
      }
      return createIdentity ? createIdentity(expected, stillCurrent) : { mode: "clerk_jwt", getToken };
    }, [state, plugin, createIdentity]);

    React.useLayoutEffect(() => {
      const scope = { plugin, active: true, epoch: 0, pending: false, current: null, refresh: async () => {} };
      session.current = scope;
      setState(null); setFailed(false); setBusy(false); setAccessFailed(false);
      let remove;
      const invalidate = () => {
        if (!scope.active) return;
        scope.epoch++; scope.current = null; setState(null); setFailed(true);
      };
      const accept = value => {
        if (!scope.active) return;
        try {
          const next = parseState(value);
          if (scope.current?.revision === next.revision && !sameState(scope.current, next)) {
            throw new Error("Native session unavailable");
          }
          scope.epoch++; scope.current = next;
          setState(previous => previous && sameState(previous, next) ? previous : next);
          setFailed(false);
        } catch { invalidate(); }
      };
      scope.refresh = async () => {
        if (!scope.active || scope.pending) return;
        const started = scope.epoch;
        try {
          const value = await plugin.getState();
          if (scope.active && !scope.pending && scope.epoch === started) accept(value);
        } catch { if (scope.active && !scope.pending && scope.epoch === started) invalidate(); }
      };
      if (available) void plugin.addListener("authStateChanged", accept).then(handle => {
        if (!scope.active) return handle.remove();
        remove = () => handle.remove();
        return scope.refresh();
      }).catch(invalidate);
      const resume = () => { if (document.visibilityState === "visible" && available) void scope.refresh(); };
      document.addEventListener("visibilitychange", resume);
      const timer = available ? window.setInterval(() => { void scope.refresh(); }, 5_000) : undefined;
      return () => {
        scope.active = false; scope.epoch++; scope.current = null;
        if (timer !== undefined) window.clearInterval(timer);
        document.removeEventListener("visibilitychange", resume);
        void remove?.().catch(() => {});
      };
    }, [plugin, available]);

    async function act(action) {
      const scope = session.current;
      if (!scope?.active || scope.pending || !available || scope.plugin !== plugin) return;
      scope.pending = true; scope.epoch++; scope.current = null;
      setState(null); setFailed(false); setBusy(true); setAccessFailed(false);
      try { await plugin[action](); }
      catch { if (scope.active) setFailed(true); }
      finally {
        scope.pending = false;
        if (scope.active) { await scope.refresh(); if (scope.active) setBusy(false); }
      }
    }
    if (!available || state?.phase === "disabled") return jsx.jsx(StatusScreen, {
      title: "Sign-in isn't available in this build", detail: "Use the approved test build to sign in to your workspace." });
    if (busy || state?.phase === "signingIn") return jsx.jsx(StatusScreen, { title: "Updating your secure session",
      detail: "Complete or cancel the sign-in window to return to Cosmas.", role: "status" });
    if (state?.phase === "ready" && identity) return jsx.jsxs(React.Fragment, { children: [
      accessFailed && jsx.jsx("div", { role: "alert", className: "team-banner", children:
        "Workspace access could not be verified. Choose an encounter to retry. Your sign-in has been retained." }),
      jsx.jsx(EncounterWorkspace, { authenticated: identity,
        accountControls: jsx.jsx("button", { className: "button secondary",
          onClick: () => void act("signOut"), children: "Sign out" }) }, state.revision),
    ] });
    if (state?.phase === "unavailable" || failed) return jsx.jsx(StatusScreen, { title: "Secure session is unavailable",
      detail: "Reopen the app to check your session again. Your workspace is closed." });
    if (!state || state.phase === "loading") return jsx.jsx(StatusScreen, { title: "Checking your session",
      detail: "Your workspace will open after your account is verified.", role: "status" });
    const pending = state.phase === "signOutPending";
    return jsx.jsx(StatusScreen, { title: pending ? "Finish signing out" : "Sign in to Cosmas",
      detail: pending ? "Your workspace is closed. Reconnect and finish signing out before continuing." :
        "Use your invited account to open your private workspace.",
      children: jsx.jsx("button", { onClick: () => void act(pending ? "signOut" : "signIn"),
        children: pending ? "Retry sign-out" : "Sign in" }) });
  };
  function sameAccount(left, right) {
    return left.identity?.userId === right.identity?.userId &&
      left.identity?.sessionId === right.identity?.sessionId &&
      left.identity?.organizationId === right.identity?.organizationId;
  }
}
