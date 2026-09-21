// Explicit local test host. Never imported by the published preview or provider entry.
/* global document, window, indexedDB */
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

// Test-only WebCrypto storage models the plugin's revision contract. This is not
// evidence of physical-device Keychain custody or a packaged native plugin.
async function encryptedFixturePlugin(name) {
  const opening = indexedDB.open(`provider-fixture-${name}`, 1);
  opening.onupgradeneeded = () => { opening.result.createObjectStore("records"); opening.result.createObjectStore("keys"); };
  const db = await result(opening);
  let key = await result(db.transaction("keys").objectStore("keys").get("key"));
  if (!key) {
    key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").put(key, "key"); await done(tx);
  }
  async function get({ key: id }) {
    const row = await result(db.transaction("records").objectStore("records").get(id));
    if (!row) throw Object.assign(new Error("missing"), { code: "SECURE_QUEUE_NOT_FOUND" });
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.iv, additionalData: new TextEncoder().encode(id) }, key, row.bytes);
    return { key: id, data: new TextDecoder().decode(bytes), revision: row.revision };
  }
  async function write({ key: id, data, expectedRevision = null }) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, key, new TextEncoder().encode(data));
    const tx = db.transaction("records", "readwrite"), store = tx.objectStore("records"), complete = done(tx);
    const previous = await result(store.get(id));
    if ((previous?.revision ?? null) !== expectedRevision) { tx.abort(); await complete.catch(() => {}); throw new Error("revision conflict"); }
    const revision = String(Number(expectedRevision ?? 0) + 1);
    store.put({ iv, bytes, revision }, id); await complete; return { revision };
  }
  return { get, create: write, compareAndSwap: write };
}
function result(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function done(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); }); }
