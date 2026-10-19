// Local-only host for the actual workspace, review, editor and encrypted journal.
/* global document, window */
import { mountProviderWorkspace, NativeProviderWorkspaceJournal, NativeCreatorReviewJournal } from "../../src/provider-entry.ts";
import { encryptedFixturePlugin } from "./encrypted-plugin.mjs";
import { encodePcm16MonoWav } from "../../src/capture/wav.ts";

const state = await fetch("/note-lab/context").then(response => response.json());
const plugin = await encryptedFixturePlugin(state.scope.workspaceId);
const abort = new AbortController();
const forbidden = () => { throw new Error("Recording, creation and external navigation are outside this fixture"); };
const savedAudioReview = new URL(window.location.href).searchParams.has("saved-audio");
const lab = window.noteLab = { passageReads: 0, dashboardOpens: 0 };
const playPassage = async (sessionId, segmentId, signal) => {
  if (signal.aborted || sessionId !== state.review.session_id || segmentId !== state.review.source.segments[0].source_segment_id) throw new Error("fixture passage scope denied");
  lab.passageReads++;
  // Four seconds outlasts the automatic note-check interval, without physical audio.
  const wav = encodePcm16MonoWav(new Int16Array(64_000), {
    sampleRateHz: 16_000, channels: 1, targetChunkDurationMs: 4000, maxEnvelopeBytes: 128_044,
  });
  let binary = ""; for (const byte of wav) binary += String.fromCharCode(byte);
  return { wavBase64: btoa(binary) };
};
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
      ...(savedAudioReview ? { playPassage } : {}),
      recorder: forbidden, openInCore: savedAudioReview ? async () => { lab.dashboardOpens++; } : forbidden,
    };
  },
});
