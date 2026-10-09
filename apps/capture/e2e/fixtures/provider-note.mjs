// Local-only host for the actual workspace, review, editor and encrypted journal.
/* global document */
import { mountProviderWorkspace, NativeProviderWorkspaceJournal, NativeCreatorReviewJournal } from "../../src/provider-entry.ts";
import { encryptedFixturePlugin } from "./encrypted-plugin.mjs";

const state = await fetch("/note-lab/context").then(response => response.json());
const plugin = await encryptedFixturePlugin(state.scope.workspaceId);
const abort = new AbortController();
const forbidden = () => { throw new Error("Recording, creation and external navigation are outside this fixture"); };
mountProviderWorkspace(document.querySelector("#provider"), {
  signal: abort.signal,
  account: { environment: "Local synthetic", email: "provider@example.invalid" },
  listEncounters: async () => state.encounters,
  createEncounter: forbidden,
  openEncounter: async (ref, signal) => {
    if (signal.aborted || ref !== state.scope.appointmentRef) throw new Error("fixture scope denied");
    return {
      encounter: state.encounters[0], scope: state.scope, signal,
      openingReview: { scope: state.scope, receivedAt: Date.now(), view: state.review },
      noteOpeningSupported: true,
      request: (path, body, key, requestSignal) => fetch(`/note-lab/${path.split("/").at(-1)}`, {
        method: "POST", body: JSON.stringify(body), signal: requestSignal,
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      }),
      journal: new NativeProviderWorkspaceJournal(plugin, state.scope.workspaceId, state.scope),
      reviewJournal: id => new NativeCreatorReviewJournal(plugin, state.scope.workspaceId, id),
      recorder: forbidden, openInCore: forbidden,
    };
  },
});
