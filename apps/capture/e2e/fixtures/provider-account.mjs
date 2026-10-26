// Local UI fixture only: normal application + workspace, synthetic SDK replies.
/* global document, window */
import { mountProviderApplication } from "../../src/provider/application.ts";

const options = new URLSearchParams(window.location.search);
const name = options.has("long") ? "Alexandria ".repeat(18).trim() : "Dr. Casey Vale";
let state = { phase: "ready", revision: crypto.randomUUID(), providerDisplayName: name };
let listener, releaseSignOut;
const stats = { signOutCalls: 0, signInCalls: 0, connections: 0, disposals: 0, aborts: 0, sourceCalls: 0 };
const forbidden = () => { stats.sourceCalls += 1; throw new Error("No recording or provider requests in account fixture"); };
const session = {
  getState: async () => state,
  addListener: async (_name, callback) => { listener = callback; return { remove: async () => { listener = undefined; } }; },
  signOut: async () => {
    stats.signOutCalls += 1;
    if (options.has("pending")) await new Promise(resolve => { releaseSignOut = resolve; });
    if (options.has("fail-once") && stats.signOutCalls === 1) throw new Error("Synthetic SDK sign-out unavailable");
    state = { phase: "signedOut", revision: crypto.randomUUID() };
    listener?.(state);
    return state;
  },
  signIn: async () => {
    stats.signInCalls += 1;
    state = { phase: "ready", revision: crypto.randomUUID(), providerDisplayName: "Dr. Morgan Reed" };
    listener?.(state);
    return state;
  },
};
const dispose = mountProviderApplication(document.querySelector("#provider"), {
  session,
  connect: async signal => {
    stats.connections += 1;
    signal.addEventListener("abort", () => { stats.aborts += 1; }, { once: true });
    return {
      workspace: { signal, listEncounters: async () => [], openEncounter: forbidden, createEncounter: forbidden },
      dispose: async () => { stats.disposals += 1; },
    };
  },
});
window.accountLab = { stats, dispose, releaseSignOut: () => releaseSignOut?.(), poll: () => listener?.(state) };
