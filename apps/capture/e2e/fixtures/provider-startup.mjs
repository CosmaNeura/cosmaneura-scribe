// Actual native adapter and capture UI with an explicitly fake native port.
// No PCM, credentials, real devices or live-service endpoints are used.
/* global document, window */
import "../../src/styles.css";
import "../../src/provider/workspace.css";
import { connectNativeProviderRecorder } from "../../src/provider/native-recorder.ts";
import { recordingFixture, syntheticSession as sessionId } from "../../src/provider/native-recorder.fixture.ts";
import { EncryptedIndexedDbQueueStorage } from "../../src/storage/encrypted-indexeddb.ts";

if (new URL(window.location.href).searchParams.get("platform") === "ios") {
  window.CapacitorCustomPlatform = { name: "ios" };
}
await import("../../src/capture-app.ts");

const native = recordingFixture();
const abort = new AbortController();
const storage = await EncryptedIndexedDbQueueStorage.open({ databaseName: `startup-${crypto.randomUUID()}` });
const unused = async () => { throw new Error("Live service or recording work is outside the startup fixture"); };
const bff = Object.fromEntries(["getAudioEncryptionKey", "createConsent", "createSession", "bindSessionAudioKey",
  "getCapabilities", "issueLease", "renewLease", "reserveChunks", "authorizeUpload", "getChunkReceipt",
  "registerChunk", "completeCapture", "getTranscriptionStatus", "getTranscript"].map(name => [name, unused]));
const command = native.port.command;
let startCalls = 0, releaseFirst;
native.port.command = request => {
  if (request.kind !== "start") return command(request);
  startCalls += 1;
  if (startCalls === 1) {
    const stale = { ...native.response(request.requestId), recording: { ...native.state, phase: "recording" } };
    return new Promise(resolve => { releaseFirst = () => resolve(stale); });
  }
  return command(request);
};
const prepared = await connectNativeProviderRecorder({ sessionId, port: native.port, bff,
  queueStorage: storage, uploadTarget: { putCompleteEnvelope: unused }, signal: abort.signal });
const app = document.createElement("cosmaneura-capture");
app.bindProvider({ sessionId, controller: prepared.controller, sourceKind: "microphone",
  encounterLabel: "Avery Example", visitLabel: "In-person visit",
  captureMode: "native_microphone", languageMode: "english", signal: abort.signal,
  authorizedRequest: unused, journal: { load: unused, save: unused },
  deactivate: prepared.deactivate });
document.querySelector("#provider").classList.add("provider-workspace");
document.querySelector("#provider").append(app);
window.startupLab = {
  get startCalls() { return startCalls; },
  get commands() { return native.commands.map(value => value.kind); },
  releaseFirst: () => releaseFirst?.(),
  close: async () => { abort.abort(); await prepared.deactivate(); storage.close(); },
};
