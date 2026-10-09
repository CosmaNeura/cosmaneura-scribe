// Explicit local test host. Never imported by the published preview or provider entry.
/* global document, window */
import { encryptedFixturePlugin } from "./encrypted-plugin.mjs";
import { mountProviderWorkspace, NativeProviderWorkspaceJournal, NativeCreatorReviewJournal } from "../../src/provider-entry.ts";
import { EncryptedIndexedDbFlowStore } from "../../src/flow/encrypted-store.ts";
import { EncryptedIndexedDbQueueStorage } from "../../src/storage/encrypted-indexeddb.ts";
import { HttpCiphertextUploadTarget } from "../../src/bff/upload-target.ts";
import { encodePcm16MonoWav, pcm16WavProfile } from "../../src/capture/index.ts";
import { acquireCaptureFlowLock } from "../../src/flow/capture-lock.ts";

const root = document.querySelector("#provider");
const abort = new AbortController();
const request = async (path, body, key, signal) => fetch(`/provider-fixture/core/${path.split("/").at(-1)}`, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
  body: JSON.stringify(body), signal, cache: "no-store", redirect: "error",
});
const state = await fetch("/provider-fixture/context", { cache: "no-store" }).then(r => r.json());
const plugin = await encryptedFixturePlugin(state.scope.workspaceId);
window.providerTest = { sourceStarts: 0, sourceStops: 0, closed: false, stopFails: false,
  revoke: () => abort.abort() };
const fixture = window.providerTest;

mountProviderWorkspace(root, {
  signal: abort.signal,
  listEncounters: async () => (await fetch("/provider-fixture/context", { cache: "no-store" }).then(r => r.json())).encounters,
  createEncounter: () => Promise.reject(new Error("Core encounter creation is outside this fixed wire fixture.")),
  openEncounter: (ref, signal) => {
    if (signal.aborted || ref !== state.scope.appointmentRef) throw new Error("fixture scope denied");
    return Promise.resolve({ encounter: state.encounters[0], scope: state.scope, request, signal,
      journal: new NativeProviderWorkspaceJournal(plugin, state.scope.workspaceId, state.scope),
      reviewJournal: id => new NativeCreatorReviewJournal(plugin, state.scope.workspaceId, id),
      openInCore: async () => {
        const response = await fetch("/provider-fixture/dashboard", { cache: "no-store" });
        if (!response.ok) throw new Error("Core read unavailable");
        const data = await response.json();
        const section = document.createElement("section"); section.setAttribute("data-core-encounter", "");
        const heading = document.createElement("h1"); heading.textContent = "Creator encounter in Core"; section.append(heading);
        for (const [key, value] of Object.entries(data.fields)) {
          const label = document.createElement("h2"), text = document.createElement("p");
          label.textContent = key; text.textContent = value; section.append(label, text);
        }
        root.append(section);
      },
      recorder: async id => {
        const releaseLock = await acquireCaptureFlowLock();
        const flowStore = await EncryptedIndexedDbFlowStore.open({ databaseName: `provider-flow-${id}` });
        const queueStorage = await EncryptedIndexedDbQueueStorage.open({ databaseName: `provider-queue-${id}` });
        return { flowStore, queueStorage, source: {
          kind: "synthetic",
          async start(options) {
            fixture.sourceStarts += 1;
            const profile = pcm16WavProfile(options.capabilities);
            const samples = new Int16Array(profile.sampleRateHz * 3).fill(7);
            await options.onChunk({ sequenceNumber: 0, durationMs: 3000, wavBytes: encodePcm16MonoWav(samples, profile) });
          },
          stop() { fixture.sourceStops += 1; return fixture.stopFails ? Promise.reject(new Error("synthetic stop unconfirmed")) : Promise.resolve(); },
        }, uploadTarget: new HttpCiphertextUploadTarget(["https://storage.invalid"], (url, init) => {
          const parsed = new URL(url);
          if (parsed.origin !== "https://storage.invalid") throw new Error("fixture upload refused");
          return fetch(`/provider-fixture/blob?path=${encodeURIComponent(parsed.pathname.replace(/\/\d{8}-/u, "/"))}`, init);
        }), release: async () => { flowStore.close(); queueStorage.close(); fixture.closed = true; await releaseLock(); } };
      },
    });
  },
});
