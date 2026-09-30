import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBffServer } from "../../capture/src/mock-bff/server";
import { HttpCaptureBff } from "../../capture/src/bff/http-client";
import { HttpCiphertextUploadTarget } from "../../capture/src/bff/upload-target";
import { connectDesktopRecorderView } from "../../capture/src/provider/desktop-recorder-view";
import { DesktopProviderRecorder } from "../src/provider-recorder.js";
import { DesktopProviderRecorderIpc } from "../src/provider-recorder-ipc.js";
import { DurableDesktopRecordStore } from "../src/durable-record-store.js";
import { DurableDesktopFlowStore } from "../src/durable-flow-store.js";
import { DurableDesktopQueueStorage } from "../src/durable-queue-store.js";
import { DurableDesktopCoverage } from "../src/durable-provider-records.js";
import { InMemoryRecordingIndicator } from "../src/recording-indicator.js";
import { NativeProcessPCMDriver } from "../src/native-process-driver.js";
import { nativePipeFixtureFence } from "../src/native-pipe-fixture.js";
import { createReadinessNativeModel, readinessModels } from "./desktop-readiness-native-model.mjs";
const workspaceId = "10000000-0000-4000-8000-000000000001", recoveryScope = "20000000-0000-4000-8000-000000000002";
const cleanup = [];
afterEach(async () => { for (const close of cleanup.reverse())
    await close(); cleanup.length = 0; });
async function fixture() {
    // There is no path that launches a native helper, even if its usual test
    // environment variable is set. All permission and PCM boundaries are fake.
    const nativeAvailability = vi.spyOn(NativeProcessPCMDriver.prototype, "getAvailability").mockResolvedValue(true);
    const nativeStart = vi.spyOn(NativeProcessPCMDriver.prototype, "start").mockImplementation(() => {
        throw new Error("Synthetic native start must be explicitly configured");
    });
    cleanup.push(() => { nativeAvailability.mockRestore(); nativeStart.mockRestore(); });
    const temporaryRoot = process.env.SCRIBE_DESKTOP_TIMING_TEMP_ROOT;
    if (!temporaryRoot) throw new Error("A runner-owned temporary directory is required");
    const directory = await mkdtemp(join(temporaryRoot, "store-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
    const server = createMockBffServer();
    cleanup.push(async () => { if (server.listening)
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const bff = new HttpCaptureBff((url, init) => fetch(typeof url === "string" ? new URL(url, origin) : url, init));
    const person = { appointment_id: "invented-desktop-appointment", practitioner_id: "invented-creator", patient_id: "invented-patient" };
    const consent = await bff.createConsent({ ...person, participant_regions: ["US-NY"], modality: "in_person", method: "verbal_attestation",
        all_parties_consented: true, granted_at: new Date().toISOString() }, { idempotencyKey: "provider-invented-consent" });
    const session = await bff.createSession({ ...person, consent_record_id: consent.id, modality: "in_person" }, { idempotencyKey: "provider-invented-session" });
    const grant = { captureSessionId: session.id, actorId: "invented-creator", consentRecordId: consent.id,
        consentStatus: "granted", sessionStatus: "authorized", source: "desktop_companion", sourceLeaseId: "invented-desktop-source" };
    const storeOptions = { directory, recoveryScope, workspaceId, key };
    let store = await DurableDesktopRecordStore.open(storeOptions);
    cleanup.push(() => store.close());
    const owned = [];
    const indicator = new InMemoryRecordingIndicator(), abort = new AbortController();
    const release = vi.fn(async () => { store.close(); });
    const authority = vi.fn(async () => {
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        return { schemaVersion: 1, decision: "authorized", ...grant, issuedAt: new Date().toISOString(), expiresAt,
            captureCapability: { capabilityId: crypto.randomUUID(), secret: "your-invented-start-capability", expiresAt } };
    });
    const selectWindow = vi.fn(async () => {
        expect(indicator.current()?.visible).not.toBe(true);
        return { application: "com.google.Chrome", processID: 1, windowID: 1 };
    });
    const complete = vi.spyOn(bff, "completeCapture");
    const originalCapabilities = await bff.getCapabilities(session.id);
    // Small invented chunks expose accepted-vs-discarded tails without real speech.
    vi.spyOn(bff, "getCapabilities").mockResolvedValue({ ...originalCapabilities, target_chunk_duration_ms: 100 });
    const resources = () => {
        const flowStore = new DurableDesktopFlowStore(store.namespace("flow"));
        return { flowStore, createSessionKey: flowStore.createSessionKey,
            storageCapacity: { availableBytes: () => store.availableBytes() },
            queueStorage: new DurableDesktopQueueStorage(store.namespace(`queue:${session.id}`), session.id),
            coverage: new DurableDesktopCoverage(store.namespace("coverage"), session.id) };
    };
    const options = { enabled: true, sessionId: session.id, signal: abort.signal,
        createBff: () => bff, authorizePreparation: async () => ({ sessionId: session.id, status: "created" }),
        authorizeMount: async () => ({ grant, status: "created" }), authority: { authorizeStart: authority },
        indicator, ...resources(), uploadTarget: new HttpCiphertextUploadTarget([origin]),
        native: { helperPath: "/unused-native-ordering-fixture", helperSha256: "0".repeat(64),
            getProcessFence: nativePipeFixtureFence,
            isSessionActive: () => !abort.signal.aborted },
        selectWindow, release, retireSource: vi.fn(async () => undefined) };
    return { options, indicator, abort, authority, selectWindow, release, complete, session, consent, nativeStart, nativeAvailability,
        open: async (overrides = {}) => {
            const recorder = await DesktopProviderRecorder.open({ ...options, ...overrides });
            owned.push(recorder);
            return recorder;
        },
        reopen: async () => { store = await DurableDesktopRecordStore.open(storeOptions); return resources(); },
        close: async () => {
            for (const recorder of owned)
                await recorder.deactivate();
            store.close();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await rm(directory, { recursive: true, force: true });
        } };
}
// The actual application uses Electron's sandboxed IPC. This port transports its
// exact cloned messages while the real recorder/flow/SQLite use simulated native I/O.
function wire(recorder) {
    let handler;
    const receive = new Set(), exits = new Map();
    const frame = { url: "app://cosmas/provider.html" }, event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
    const messages = [];
    const boundary = new DesktopProviderRecorderIpc({ handle: (_channel, fn) => { handler = fn; }, removeHandler: () => { handler = undefined; } }, { id: 7, mainFrame: frame, isDestroyed: () => false, send: (_channel, value) => {
            messages.push(structuredClone(value));
            receive.forEach(listener => listener(structuredClone(value)));
        }, on: (name, fn) => { exits.set(name, fn); }, removeListener: name => { exits.delete(name); } }, recorder);
    boundary.install();
    const invoke = (value, sender = event) => handler(sender, structuredClone(value));
    const port = { request: value => invoke(value), subscribe: listener => {
            receive.add(listener);
            return () => receive.delete(listener);
        } };
    return { port, boundary, invoke, event, messages, exits };
}
const profileOptions = [
    { name: "local-zero-delay", apiMs: 0, availabilityMs: 0, nativeReadyMs: 0 },
    { name: "moderate-dependencies", apiMs: 300, availabilityMs: 700, nativeReadyMs: 400 },
    { name: "slow-dependencies", apiMs: 900, availabilityMs: 900, nativeReadyMs: 900 },
];
const runs = Number(process.env.SCRIBE_DESKTOP_TIMING_RUNS ?? "1");
const selectedProfile = process.env.SCRIBE_DESKTOP_TIMING_PROFILE ?? "all";
const modelName = process.env.SCRIBE_DESKTOP_TIMING_MODEL ?? "modern-clean";
const output = process.env.SCRIBE_DESKTOP_TIMING_OUTPUT;
if (!output || !Number.isInteger(runs) || runs < 1 || runs > 5
    || !["all", ...profileOptions.map(value => value.name)].includes(selectedProfile) || !readinessModels.includes(modelName))
    throw new Error("Run through test-tools/desktop-readiness-benchmark.mjs");
const profiles = profileOptions.filter(value => selectedProfile === "all" || value.name === selectedProfile)
    .flatMap(value => Array.from({ length: runs }, (_, index) => ({ ...value, run: index + 1 })));
const waitMs = (ms) => new Promise(resolve => setTimeout(resolve, ms));
describe("isolated desktop readiness measurements", () => {
    it.each(profiles)("measures $name using real flow/storage/IPC and a no-audio native boundary", async (profile) => {
        const f = await fixture();
        const origin = performance.now();
        let phase = "setup";
        const spans = [];
        const updates = [];
        const actions = {};
        async function timed(label, delay, fn, boundary = "dependency-sensitivity") {
            const began = performance.now(), action = phase;
            try {
                if (delay)
                    await waitMs(delay);
                return await fn();
            }
            finally {
                spans.push({ phase: action, label, boundary, injected_delay_ms: delay, start_ms: began - origin, duration_ms: performance.now() - began });
            }
        }
        const bff = f.options.createBff(f.abort.signal);
        for (const name of ["getCapabilities", "getAudioEncryptionKey", "bindSessionAudioKey", "issueLease", "reserveChunks", "renewLease"]) {
            const method = bff[name];
            const original = vi.isMockFunction(method) ? method.getMockImplementation() : method;
            vi.spyOn(bff, name).mockImplementation((...args) => timed(`bff.${name}`, profile.apiMs, () => Reflect.apply(original, bff, args), "loopback-bff"));
        }
        f.nativeAvailability.mockImplementation(() => timed("os.availability", profile.availabilityMs, async () => true, "simulated-os"));
        const authorizePreparation = () => timed("trusted.prepare", profile.apiMs, async () => ({ sessionId: f.session.id, status: "created" }), "simulated-remote");
        const nativeModel = modelName === "dependency-sensitivity" ? null : await createReadinessNativeModel({
            model: modelName, sessionId: f.session.id, consentRecordId: f.consent.id, signal: f.abort.signal, timed, apiMs: profile.apiMs });
        if (nativeModel) cleanup.push(() => nativeModel.close());
        const authorizeMount = nativeModel ? nativeModel.mount.authorizeRecorder
            : (value, signal) => timed("trusted.mount", profile.apiMs, () => f.options.authorizeMount(value, signal));
        const originalAuthority = f.authority.getMockImplementation();
        f.authority.mockImplementation(() => timed("trusted.start-authority", profile.apiMs, originalAuthority));
        const originalSelect = f.selectWindow.getMockImplementation();
        f.selectWindow.mockImplementation(() => timed("picker.synthetic-immediate-choice", 0, originalSelect));
        const originalRetire = f.options.retireSource;
        const retireSource = nativeModel ? nativeModel.retireSource : () => timed("trusted.retire", profile.apiMs, originalRetire);
        const authority = nativeModel ? nativeModel.mount.authority : f.options.authority;
        let sink, frames = 0;
        const startMetadata = { hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" };
        f.nativeStart.mockImplementation((_configuration, value) => {
            nativeModel?.assertNativeStartAllowed();
            expect(f.indicator.current()?.visible).toBe(true);
            spans.push({ phase, label: "native.start-simulated", boundary: "simulated-native", injected_delay_ms: 0, start_ms: performance.now() - origin, duration_ms: 0 });
            sink = value;
            frames = 0;
            return { ready: timed("native.ready-simulated", profile.nativeReadyMs, async () => startMetadata, "simulated-native"),
                activate: () => { spans.push({ phase, label: "native.activate-simulated", boundary: "simulated-native", injected_delay_ms: 0, start_ms: performance.now() - origin, duration_ms: 0 }); },
                stop: async ({ mode }) => timed("native.stop-simulated", 0, async () => mode === "discard" ? null : ({ start: startMetadata,
                    endHostTimeNanoseconds: "1100000000", outputFrames: frames,
                    microphoneTailNanoseconds: "0", systemTailNanoseconds: "0" }), "simulated-native") };
        });
        const emitSyntheticChunk = async () => { frames = 1600; await sink.onPcmPacket({ firstFrame: 0, pcmBytes: new Uint8Array(3200) }); };
        async function action(name, fn) {
            phase = name;
            const began = performance.now(), relative = began - origin;
            const value = await fn();
            const relevant = updates.filter(row => row.phase === name);
            const recording = relevant.find(row => row.desktop === "recording");
            const native = spans.find(row => row.phase === name && row.label === "native.ready-simulated");
            actions[name] = { duration_ms: performance.now() - began,
                ...(relevant[0] ? { first_state_update_ms: relevant[0].at_ms - relative } : {}),
                ...(recording ? { recording_snapshot_ms: recording.at_ms - relative } : {}),
                ...(native ? { native_ready_ms: native.start_ms + native.duration_ms - relative } : {}) };
            phase = "idle";
            return value;
        }
        let recorder = await action("cold-open-fresh-store", () => f.open({ authorizePreparation, authorizeMount, retireSource, authority }));
        expect(recorder.snapshot.desktop?.phase).toBe("ready");
        await recorder.deactivate();
        const resources = await f.reopen();
        recorder = await action("repeat-open-retained-ready", () => f.open({ ...resources, authorizePreparation, authorizeMount, retireSource, authority }));
        const w = wire(recorder), view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
        const unsubscribe = view.controller.subscribe(value => {
            const key = `${phase}:${value.state}:${value.desktop?.phase}:${value.statusCode}`;
            const previous = updates.at(-1);
            if (previous && `${previous.phase}:${previous.state}:${previous.desktop}:${previous.status}` === key)
                return;
            updates.push({ phase, at_ms: performance.now() - origin, state: value.state, desktop: value.desktop?.phase ?? "", status: value.statusCode });
        });
        try {
            await action("start-to-simulated-capture-ready", () => view.controller.startRecording());
            expect(view.controller.snapshot.desktop?.phase).toBe("recording");
            await emitSyntheticChunk();
            if (modelName === "modern-interrupted") {
                await action("native-interruption-to-paused", async () => {
                    sink.onFailure("device_changed");
                    await vi.waitFor(() => expect(view.controller.snapshot.state).toBe("paused"), { timeout: 3000 });
                });
                expect(nativeModel.ownerCount()).toBe(1);
            } else {
                await action("pause-to-confirmed-simulated-stop", () => view.controller.pauseRecording());
                if (nativeModel) expect(nativeModel.ownerCount()).toBe(0);
            }
            expect(view.controller.snapshot.state).toBe("paused");
            await action("resume-to-simulated-capture-ready", () => view.controller.resumeRecording());
            expect(view.controller.snapshot.desktop?.phase).toBe("recording");
            const assertions = [];
            if (nativeModel) {
                for (const name of ["start-to-simulated-capture-ready", "resume-to-simulated-capture-ready"]) {
                    const rows = spans.filter(row => row.phase === name);
                    const index = label => rows.findIndex(row => row.label === label);
                    const source = modelName === "legacy-clean" ? "remote.sourcePrepare" : "remote.sourcePrepareAndAuthorize";
                    for (const label of ["picker.synthetic-immediate-choice", source, "local.sourceAuthorizeConsume",
                        "native.start-simulated", "native.ready-simulated", "native.activate-simulated"])
                        expect(index(label), `Missing required ${label} span in ${name}`).toBeGreaterThanOrEqual(0);
                    expect(index(source)).toBeGreaterThan(index("picker.synthetic-immediate-choice"));
                    expect(index("local.sourceAuthorizeConsume")).toBeGreaterThan(index(source));
                    const probes = rows.filter(row => row.label === "os.availability");
                    expect(probes.length).toBeGreaterThanOrEqual(2);
                    expect(probes.at(-1).start_ms).toBeGreaterThanOrEqual(rows[index("local.sourceAuthorizeConsume")].start_ms);
                    expect(index("native.start-simulated")).toBeGreaterThan(index("local.sourceAuthorizeConsume"));
                    expect(index("native.activate-simulated")).toBeGreaterThan(index("native.ready-simulated"));
                    expect(rows[index("native.start-simulated")].start_ms).toBeGreaterThanOrEqual(probes.at(-1).start_ms + probes.at(-1).duration_ms);
                    expect(updates.find(row => row.phase === name && row.desktop === "recording").at_ms)
                        .toBeGreaterThanOrEqual(rows[index("native.activate-simulated")].start_ms);
                }
                for (const stopped of spans.filter(row => row.label === "remote.sourceStopped")) {
                    const started = spans.filter(row => row.label === "native.start-simulated" && row.start_ms < stopped.start_ms).at(-1);
                    expect(spans.some(row => row.label === "native.stop-simulated"
                        && row.start_ms >= started.start_ms && row.start_ms + row.duration_ms <= stopped.start_ms)).toBe(true);
                }
                const resumed = spans.filter(row => row.phase === "resume-to-simulated-capture-ready");
                expect(resumed.filter(row => row.label === "remote.sourceStopped")).toHaveLength(modelName === "modern-interrupted" ? 1 : 0);
                expect(resumed.filter(row => row.label === "noop.retireSource")).toHaveLength(modelName === "modern-interrupted" ? 0 : 1);
                expect(resumed.filter(row => row.label === "remote.sourceAuthorize")).toHaveLength(modelName === "legacy-clean" ? 1 : 0);
                if (modelName === "modern-interrupted") {
                    const stopped = resumed.find(row => row.label === "remote.sourceStopped");
                    expect(resumed.find(row => row.label === "bff.renewLease").start_ms).toBeGreaterThanOrEqual(stopped.start_ms + stopped.duration_ms);
                }
                assertions.push("actual backend owner removed only after confirmed retirement", "consumed local decision required before native start",
                    "fresh source availability retained after authority", "picker before source preparation",
                    "native ready before activation and Recording snapshot", "native stop before server retirement",
                    modelName === "modern-interrupted" ? "retained owner retired before lease renewal" : "clean Resume retirement issues no native or remote request");
            }
            await emitSyntheticChunk();
            await view.controller.pauseRecording();
            const result = { profile, model: modelName, assertions, boundary_operations: nativeModel?.events ?? [],
                source: "actual recorder/controller/flow/encrypted SQLite/cloned IPC; actual native backend except dependency-sensitivity; loopback BFF; simulated Swift/HTTP/OS/native readiness", actions, spans, updates,
                human_picker_delay_ms: 0, microphone_or_native_executable_used: false, actual_app_startup_or_dom_paint_measured: false };
            await writeFile(join(output, `${profile.name}-run-${profile.run}.json`), JSON.stringify(result, null, 2) + "\n");
            console.log(JSON.stringify({ profile: profile.name, run: profile.run, actions }));
        }
        finally {
            unsubscribe();
            await w.boundary.dispose();
            await f.close();
        }
    }, 40000);
});
