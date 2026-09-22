/* global document, window */
// Applied only to the hash-verified, retained W13 web asset. The native SDK,
// Keychain, token policy and API authorization are not changed by this adapter.
export function createWorkspaceRecovery({ React, jsx, WorkspaceAuth, availableByDefault,
  StatusScreen, EncounterWorkspace, parseState, parseToken, sameState, privateCatalog = false }) {
  const tokenFailureCodes = new Set(["app_binding_missing", "app_binding_mismatch", "request_failed", "request_pending",
    "empty", "identity_changed", "policy_passed", "policy_rejected"].map(code => "workspace_token_" + code));
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
      async function getCatalog() {
        try {
          if (!stillCurrent()) throw new Error();
          const result = await plugin.getWorkspaceCatalog({ expectedRevision: expected.revision });
          if (!stillCurrent() || result?.revision !== expected.revision || !Array.isArray(result.encounters) ||
              result.encounters.length > 100) throw new Error();
          setAccessFailed(false);
          return result.encounters;
        } catch (error) {
          if (scope?.active && !scope.pending && session.current === scope &&
              (!scope.current?.identity || sameAccount(scope.current, expected))) {
            const code = error?.code;
            setAccessFailed(code === "workspace_connection_unavailable" ? "connection" :
              code === "workspace_jwt_rejected" ? "server" : code === "workspace_access_denied" ? "access" :
                tokenFailureCodes.has(code) ? code : true);
          }
          // Native provider errors are intentionally discarded at the UI boundary.
          // eslint-disable-next-line preserve-caught-error
          throw new Error("Native workspace unavailable");
        }
      }
      return createIdentity ? createIdentity(expected, stillCurrent) : {
        mode: "clerk_jwt", getToken, ...(privateCatalog ? { getCatalog } : {}),
      };
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
        accessFailed === "connection" ? "Could not connect securely to the workspace on your Mac. Check that both devices are connected, then choose an encounter to retry." :
        accessFailed === "server" ? "The workspace could not verify this session. Your sign-in has been retained; access needs to be checked." :
        accessFailed === "access" ? "This account does not currently have access to the test workspace. Your sign-in has been retained." :
          tokenFailureDetail(accessFailed) ?? "Workspace access could not be verified. Choose an encounter to retry. Your sign-in has been retained." }),
      jsx.jsx(EncounterWorkspace, { authenticated: identity,
        accountControls: jsx.jsx("button", { className: "button secondary",
          onClick: () => void act("signOut"), children: "Sign out" }) }, state.revision),
    ] });
    if (state?.phase === "unavailable" || failed) return jsx.jsx(StatusScreen, { title: "Secure session is unavailable",
      detail: tokenFailureDetail(accessFailed) ?? "Reopen the app to check your session again. Your workspace is closed." });
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
  function tokenFailureDetail(code) {
    return tokenFailureCodes.has(code)
      ? `The private connection succeeded, but session verification failed (${code.slice("workspace_token_".length)}). Your workspace remains closed.`
      : null;
  }
}
