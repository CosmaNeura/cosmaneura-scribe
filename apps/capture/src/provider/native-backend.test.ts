import { webcrypto } from "node:crypto";
import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { CoreCaptureBff, CoreCaptureClient } from "./core-client";
import { longReviewFixture } from "../../../review-ui/src/long-review.fixture";
import { MAX_CORE_CAPTURE_RESPONSE_BYTES } from "../../../review-ui/src/capture-response-limits";
import { connectNativeProviderIOSBackend, type NativeProviderOptions, type ProviderNativePlugin } from "./native-backend";

const workspace = "10000000-0000-4000-8000-000000000001";
const recovery = "20000000-0000-4000-8000-000000000002";
const session = "30000000-0000-4000-8000-000000000003";
const appointment = "appointment_01j00000000000000000000000";
const binding = "scribe_capture_binding_01j00000000000000000000000";
type NativeRequest = Parameters<ProviderNativePlugin["providerRequest"]>[0];
type NativeReply = Awaited<ReturnType<ProviderNativePlugin["providerRequest"]>>;
type NativeState = Awaited<ReturnType<ProviderNativePlugin["getProviderState"]>>;

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  vi.spyOn(Capacitor, "getPlatform").mockReturnValue("ios");
  vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const abort = new AbortController(), removed = vi.fn(async () => undefined);
  let state: NativeState = { phase: "ready", revision: crypto.randomUUID(), providerReady: true };
  let listener: (state: NativeState) => void = () => undefined;
  const encounter = { appointmentRef: appointment, title: "Invented visit", detail: "Offline fixture" };
  const reply = (request: NativeRequest, value?: unknown, status = 200): NativeReply => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const receipt = { session_id: session };
    const result = request.action === "catalog" ? { revision: request.revision,
      encounters: [{ workspaceId: workspace, ...encounter }] }
      : request.action === "mount" ? { revision: request.revision, workspaceId: workspace,
        recoveryScope: recovery, appointmentRef: appointment, bindingRef: binding, encounter }
        : request.action === "recorder-context" ? { revision: request.revision, session_id: body.session_id, authorization_id: body.request_nonce }
          : request.action === "recorder" ? { revision: request.revision, session_id: body.session_id }
          : { contract_version: "1", workspace_id: workspace, binding_ref: binding,
            request_nonce: body.request_nonce, checked_at: new Date().toISOString(),
            appointment_ref: appointment, operation_ref: "scribe_admission_01j00000000000000000000000",
            session_id: session, consent_record_id: crypto.randomUUID(), receipt,
            operation: (body.operation as { kind: string } | undefined)?.kind, action: body.action };
    return { requestId: request.requestId, revision: request.revision, status, body: JSON.stringify(value ?? result) };
  };
  const plugin = {
    getProviderState: vi.fn(async () => state),
    addListener: vi.fn<ProviderNativePlugin["addListener"]>(async (_event, callback) => {
      listener = callback; return { remove: removed };
    }),
    providerRequest: vi.fn<ProviderNativePlugin["providerRequest"]>(async request => reply(request)),
    cancelProviderRequest: vi.fn(async () => undefined),
    prepareProviderSource: vi.fn<ProviderNativePlugin["prepareProviderSource"]>(async value => ({ revision: value.revision, sessionId: value.sessionId })),
    closeProviderSource: vi.fn(async () => undefined),
    openProviderRecording: vi.fn<NonNullable<ProviderNativePlugin["openProviderRecording"]>>(async () => ({})),
    providerRecordingCommand: vi.fn<NonNullable<ProviderNativePlugin["providerRecordingCommand"]>>(async () => ({})),
    getToken: vi.fn(() => { throw new Error("A native token must not be requested by JavaScript"); }),
  };
  const coreOpen = vi.fn(async () => undefined);
  const options: NativeProviderOptions = { signal: abort.signal,
    uploadTarget: { putCompleteEnvelope: vi.fn(async () => undefined) },
    core: { createEncounter: vi.fn(async () => undefined), openEncounter: coreOpen } };
  return { options, plugin, removed, abort, reply, coreOpen, get state() { return state; },
    setState: (value: NativeState, emit = true) => { state = value; if (emit) listener(state); },
    connect: () => connectNativeProviderIOSBackend(options, plugin) };
}

describe("native provider connection", () => {
  it("opens with a complete long transcript without a second Core request", async () => {
    const f = fixture(), backend = await f.connect(), view = longReviewFixture(session);
    f.plugin.providerRequest.mockImplementation(async request => {
      const result = JSON.parse(f.reply(request).body);
      if (request.action === "catalog") result.opening_review_v1 = true;
      if (request.action === "mount") result.openingReview = {
        contract_version: "1", workspace_id: workspace, binding_ref: binding,
        request_nonce: JSON.parse(request.body).opening_nonce, checked_at: new Date().toISOString(),
        operation: "provider_encounter", receipt: { schema_version: "1.0", status: "available", review: view },
      };
      return f.reply(request, result);
    });
    try {
      await backend.listEncounters(backend.signal);
      const mount = await backend.openEncounter(appointment, backend.signal);
      expect(mount.openingReview?.view).toEqual(view);
      expect(f.plugin.providerRequest.mock.calls.map(([r]) => r.action)).toEqual(["catalog", "mount"]);
    } finally { await backend.dispose(); }
  });

  it.each([false, true])("requests a combined opening only with advertised capability (%s)", async supported => {
    const f = fixture(), backend = await f.connect();
    f.plugin.providerRequest.mockImplementation(async request => {
      const normal = f.reply(request), value = JSON.parse(normal.body);
      if (request.action === "catalog") value.opening_review_v1 = supported;
      if (request.action === "mount" && supported) value.openingReview = {
        contract_version: "1", workspace_id: workspace, binding_ref: binding,
        request_nonce: JSON.parse(request.body).opening_nonce, checked_at: new Date().toISOString(),
        operation: "provider_encounter", receipt: { schema_version: "1.0", status: "not_prepared", review: null },
      };
      return { ...normal, body: JSON.stringify(value) };
    });
    try {
      await backend.listEncounters(backend.signal);
      const mount = await backend.openEncounter(appointment, backend.signal);
      expect(mount.openingReview?.view).toBe(supported ? null : undefined);
      const body = JSON.parse(f.plugin.providerRequest.mock.calls[1]![0].body);
      expect(Object.keys(body).sort()).toEqual(supported ? ["opening_nonce", "workspace_id"] : ["workspace_id"]);
      await mount.reauthorizeRecorder(session, backend.signal);
      expect(f.plugin.providerRequest.mock.calls.map(([r]) => r.action)).toEqual(["catalog", "mount", "recorder"]);
      expect(f.plugin.openProviderRecording).not.toHaveBeenCalled();
    } finally { await backend.dispose(); }
  });

  it.each([false, true])("gates note opening on its own advertised capability (%s)", async supported => {
    const f = fixture(), backend = await f.connect();
    f.plugin.providerRequest.mockImplementation(async request => {
      const normal = f.reply(request), value = JSON.parse(normal.body);
      if (request.action === "catalog") value.note_opening_v1 = supported;
      if (request.action === "note-opening") Object.assign(value, { operation: "note_opening",
        receipt: { session_id: session, separate_reads_required: true } });
      return { ...normal, body: JSON.stringify(value) };
    });
    try {
      await backend.listEncounters(backend.signal);
      const mount = await backend.openEncounter(appointment, backend.signal);
      expect(mount.noteOpeningSupported).toBe(supported ? true : undefined);
      const client = new CoreCaptureClient(mount.scope, mount.request, mount.signal);
      if (supported) expect(await client.openNote(session)).toEqual({ session_id: session, separate_reads_required: true });
      else await expect(client.openNote(session)).rejects.toThrow();
      expect(f.plugin.providerRequest.mock.calls.map(([r]) => r.action))
        .toEqual(["catalog", "mount", ...(supported ? ["note-opening"] : [])]);
      expect(f.plugin.openProviderRecording).not.toHaveBeenCalled();
    } finally { await backend.dispose(); }
  });

  it("passes a full long review through native and Core receivers while retaining the byte guard", async () => {
    const f = fixture(), backend = await f.connect();
    try {
      await backend.listEncounters(backend.signal);
      const mount = await backend.openEncounter(appointment, backend.signal);
      const client = new CoreCaptureClient(mount.scope, mount.request, mount.signal);
      const receipt = longReviewFixture(session);
      f.plugin.providerRequest.mockImplementationOnce(async request => f.reply(request, {
        ...JSON.parse(f.reply(request).body), receipt,
      }));
      expect(await client.operation(session, { kind: "creator_review" })).toEqual(receipt);
      f.plugin.providerRequest.mockImplementationOnce(async request => ({ ...f.reply(request),
        body: " ".repeat(MAX_CORE_CAPTURE_RESPONSE_BYTES + 1) }));
      await expect(client.operation(session, { kind: "creator_review" })).rejects.toThrow();
    } finally { await backend.dispose(); }
  });
  it("connects catalog, scope, actual Core client and recorder reauthorization without a JS token", async () => {
    const f = fixture(), backend = await f.connect();
    try {
      expect(await backend.listEncounters(backend.signal)).toHaveLength(1);
      const mount = await backend.openEncounter(appointment, backend.signal);
      expect(mount.recoveryScope).toBe(recovery); expect(mount.uploadTarget).toBe(f.options.uploadTarget);
      const client = new CoreCaptureClient(mount.scope, mount.request, mount.signal);
      expect(await client.admit({ key: "invented-admission-key", languageMode: "en-US+es-US",
        attestation: { modality: "in_person", participant_regions: ["US-NY"], method: "verbal_attestation",
          all_parties_consented: true, granted_at: new Date().toISOString() } })).toBe(session);
      await mount.reauthorizeRecorder(session, backend.signal);
      await client.operation(session, { kind: "creator_review" });
      await client.note(session, "templates");
      await mount.openInCore(null);
      expect(f.coreOpen).toHaveBeenCalledWith(appointment, null, backend.signal);
      expect(f.plugin.providerRequest.mock.calls.map(([request]) => request.action)).toEqual([
        "catalog", "mount", "capture-admissions", "recorder", "capture-operations", "capture-notes", "mount",
      ]);
      expect(f.plugin.providerRequest.mock.calls[2]![0].key).toBe("invented-admission-key");
      for (const [request] of f.plugin.providerRequest.mock.calls) {
        expect(Object.keys(request).sort()).toEqual(["action", "body", "key", "requestId", "revision"]);
      }
      expect(f.plugin.getToken).not.toHaveBeenCalled();
    } finally { await backend.dispose(); }
    expect(f.removed).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels native I/O on logout and discards an uncooperative late reply", async () => {
    const f = fixture(), backend = await f.connect(), wire = deferred<NativeReply>();
    f.plugin.providerRequest.mockImplementationOnce(() => wire.promise);
    const pending = backend.listEncounters(backend.signal);
    const rejected = expect(pending).rejects.toThrow("provider_native_connection_unavailable");
    const request = f.plugin.providerRequest.mock.calls[0]![0];
    f.setState({ phase: "signedOut", revision: crypto.randomUUID() });
    await rejected;
    expect(f.plugin.cancelProviderRequest).toHaveBeenCalledWith({ requestId: request.requestId });
    wire.resolve(f.reply(request)); await Promise.resolve();
    expect(backend.signal.aborted).toBe(true);
    await expect(backend.openEncounter(appointment, new AbortController().signal)).rejects.toThrow();
    await backend.dispose(); expect(f.removed).toHaveBeenCalledTimes(1);
  });

  it("cancels an encounter request without cancelling the signed-in backend", async () => {
    const f = fixture(), backend = await f.connect(), operation = new AbortController(), wire = deferred<NativeReply>();
    await backend.listEncounters(backend.signal);
    f.plugin.providerRequest.mockImplementationOnce(() => wire.promise);
    const pending = backend.openEncounter(appointment, operation.signal);
    const rejected = expect(pending).rejects.toThrow();
    const request = f.plugin.providerRequest.mock.calls.at(-1)![0];
    operation.abort(); await rejected;
    expect(backend.signal.aborted).toBe(false);
    wire.resolve(f.reply(request)); await Promise.resolve();
    expect(f.plugin.cancelProviderRequest).toHaveBeenCalledWith({ requestId: request.requestId });
    await backend.dispose();
  });

  it("cancels a timed-out queue request and retries its key on the same native connection", async () => {
    const f = fixture(), backend = await f.connect(), wire = deferred<NativeReply>();
    try {
      await backend.listEncounters(backend.signal);
      const mount = await backend.openEncounter(appointment, backend.signal);
      const bff = new CoreCaptureBff(new CoreCaptureClient(mount.scope, mount.request, mount.signal), session);
      const transport = new BffCaptureQueueTransport(bff, f.options.uploadTarget);
      const object = crypto.randomUUID(), key = "invented-upload-retry-key";
      f.plugin.providerRequest.mockImplementationOnce(() => wire.promise);
      const pending = transport.authorizeUpload(session, object, key);
      const rejected = expect(pending).rejects.toMatchObject({ kind: "unknown_success" });
      await vi.advanceTimersByTimeAsync(30_000); await rejected;
      const request = f.plugin.providerRequest.mock.calls.at(-1)![0];
      expect(f.plugin.cancelProviderRequest).toHaveBeenCalledWith({ requestId: request.requestId });
      expect(backend.signal.aborted).toBe(false);
      wire.resolve(f.reply(request)); await Promise.resolve();
      const receipt = { protocol_version: "1.0", object_id: object, additional_authenticated_data: "c3ludGhldGlj",
        upload_url: "https://upload.example.test/invented", expires_at: new Date(Date.now() + 60_000).toISOString() };
      f.plugin.providerRequest.mockImplementationOnce(async retry => {
        expect(retry.key).toBe(key); expect(retry.requestId).not.toBe(request.requestId);
        return f.reply(retry, { ...JSON.parse(f.reply(retry).body), receipt });
      });
      await expect(transport.authorizeUpload(session, object, key)).resolves.toMatchObject({ objectId: object });
      expect(f.plugin.cancelProviderRequest).toHaveBeenCalledTimes(1);
    } finally { await backend.dispose(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still cancels native I/O when the encounter closes during a queue request", async () => {
    const f = fixture(), backend = await f.connect(), encounter = new AbortController(), requestAbort = new AbortController();
    const wire = deferred<NativeReply>();
    try {
      await backend.listEncounters(backend.signal);
      const mount = await backend.openEncounter(appointment, encounter.signal);
      const bff = new CoreCaptureBff(new CoreCaptureClient(mount.scope, mount.request, mount.signal), session);
      f.plugin.providerRequest.mockImplementationOnce(() => wire.promise);
      const pending = bff.getCapabilities(session, { signal: requestAbort.signal });
      const rejected = expect(pending).rejects.toThrow();
      const request = f.plugin.providerRequest.mock.calls.at(-1)![0];
      encounter.abort(); await rejected;
      expect(f.plugin.cancelProviderRequest).toHaveBeenCalledWith({ requestId: request.requestId });
      expect(requestAbort.signal.aborted).toBe(false); expect(backend.signal.aborted).toBe(false);
      wire.resolve(f.reply(request)); await Promise.resolve();
    } finally { await backend.dispose(); }
  });

  it("rejects a stale initial state and removes a listener that arrives after cancellation", async () => {
    const f = fixture(), read = deferred<NativeState>();
    f.plugin.getProviderState.mockImplementationOnce(() => read.promise);
    const connecting = f.connect(), rejected = expect(connecting).rejects.toThrow();
    await Promise.resolve(); await Promise.resolve();
    const old = f.state;
    f.setState({ phase: "ready", revision: crypto.randomUUID() }); read.resolve(old);
    await rejected; expect(f.removed).toHaveBeenCalledTimes(1);
    const late = fixture(), added = deferred<{ remove: typeof late.removed }>();
    late.plugin.addListener.mockImplementationOnce(() => added.promise);
    const another = late.connect(), cancelled = expect(another).rejects.toThrow();
    late.abort.abort(); added.resolve({ remove: late.removed });
    await cancelled; expect(late.removed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects a passive native session change without requesting tokens", async () => {
    const f = fixture(), backend = await f.connect();
    f.setState({ phase: "signedOut", revision: crypto.randomUUID() }, false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.signal.aborted).toBe(true); expect(f.plugin.getToken).not.toHaveBeenCalled();
    await backend.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it("sends no provider payload unless native logging and endpoint readiness are confirmed", async () => {
    const f = fixture();
    f.setState({ phase: "ready", revision: crypto.randomUUID(), providerReady: false });
    await expect(f.connect()).rejects.toThrow();
    expect(f.plugin.providerRequest).not.toHaveBeenCalled();
    expect(f.removed).toHaveBeenCalledTimes(1);
    const active = fixture(), backend = await active.connect();
    active.setState({ ...active.state, providerReady: false }, false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.signal.aborted).toBe(true); await backend.dispose();
  });

  it("closes on access revocation but preserves recovery on a Core conflict", async () => {
    const f = fixture(), backend = await f.connect();
    await backend.listEncounters(backend.signal);
    const mount = await backend.openEncounter(appointment, backend.signal);
    const body = { workspace_id: workspace, binding_ref: binding, request_nonce: crypto.randomUUID() };
    f.plugin.providerRequest.mockImplementationOnce(async request => f.reply(request, {}, 409));
    const response = await mount.request("/service/v1/agent/scribe/capture-notes", body, "same-save-key", backend.signal);
    expect(response.status).toBe(409); expect(backend.signal.aborted).toBe(false);
    f.plugin.providerRequest.mockImplementationOnce(async request => f.reply(request, {}, 403));
    await expect(mount.request("/service/v1/agent/scribe/capture-notes", body, "same-save-key", backend.signal)).rejects.toMatchObject({ status: 403 });
    expect(backend.signal.aborted).toBe(true); await backend.dispose();
  });

  it("rejects scope substitution, arbitrary paths and synchronous native failures", async () => {
    const f = fixture(), backend = await f.connect();
    await backend.listEncounters(backend.signal);
    f.plugin.providerRequest.mockImplementationOnce(async request => ({ ...f.reply(request),
      body: JSON.stringify({ revision: request.revision, workspaceId: crypto.randomUUID() }) }));
    await expect(backend.openEncounter(appointment, backend.signal)).rejects.toThrow();
    const mount = await backend.openEncounter(appointment, backend.signal);
    const calls = f.plugin.providerRequest.mock.calls.length;
    await expect(mount.request("https://foreign.invalid/", {}, "invented-key", backend.signal)).rejects.toThrow();
    expect(f.plugin.providerRequest).toHaveBeenCalledTimes(calls);
    f.plugin.providerRequest.mockImplementationOnce(() => { throw new Error("private SDK error"); });
    await expect(backend.listEncounters(backend.signal)).rejects.toThrow("provider_native_connection_unavailable");
    await backend.dispose(); expect(f.plugin.cancelProviderRequest).not.toHaveBeenCalled();
  });
});


it("binds native commands to the verified mount and revision, retaining close after revocation", async () => {
  const f = fixture(); f.setState({ ...f.state, nativeRecordingVersion: 1 }, false);
  const backend = await f.connect();
  try {
    await backend.listEncounters(backend.signal);
    const mount = await backend.openEncounter(appointment, backend.signal), id = crypto.randomUUID();
    expect(mount.nativeRecording).toBeDefined();
    await mount.nativeRecording!.open(session, id);
    expect(f.plugin.openProviderRecording).toHaveBeenCalledWith({ requestId: id, sessionId: session,
      revision: f.state.revision, workspaceId: workspace, bindingRef: binding });
    f.abort.abort();
    expect(() => mount.nativeRecording!.command({ requestId: id, recorderId: id, kind: "start" })).toThrow();
    await mount.nativeRecording!.command({ requestId: id, recorderId: id, kind: "close" });
    expect(f.plugin.providerRecordingCommand).toHaveBeenCalledWith({ requestId: id, recorderId: id,
      revision: f.state.revision, kind: "close" });
  } finally { await backend.dispose(); }
});

it("keeps older native builds on their existing recorder", async () => {
  const f = fixture(), backend = await f.connect();
  try {
    await backend.listEncounters(backend.signal);
    expect((await backend.openEncounter(appointment, backend.signal)).nativeRecording).toBeUndefined();
  } finally { await backend.dispose(); }
});

it("reuses one acknowledged native context once after recorder reauthorization", async () => {
  const f = fixture(); f.setState({ ...f.state, nativeRecordingVersion: 2 }, false);
  const backend = await f.connect();
  try {
    await backend.listEncounters(backend.signal);
    const mount = await backend.openEncounter(appointment, backend.signal);
    expect(() => mount.nativeRecording!.open(session, crypto.randomUUID())).toThrow();
    await mount.reauthorizeRecorder(session, backend.signal);
    const prepared = f.plugin.providerRequest.mock.calls.at(-1)![0];
    expect(prepared.action).toBe("recorder-context");
    const body = JSON.parse(prepared.body) as { request_nonce: string };
    const requestId = crypto.randomUUID();
    await mount.nativeRecording!.open(session, requestId);
    expect(f.plugin.openProviderRecording).toHaveBeenCalledWith({ requestId, revision: f.state.revision,
      workspaceId: workspace, bindingRef: binding, sessionId: session, authorizationId: body.request_nonce });
    expect(() => mount.nativeRecording!.open(session, crypto.randomUUID())).toThrow();
    expect(f.plugin.providerRequest.mock.calls.map(([request]) => request.action)).toEqual(["catalog", "mount", "recorder-context"]);
  } finally { await backend.dispose(); }
});

it.each(["nonce", "session", "extra", "denied"])("rejects invalid prepared context acknowledgement %s", async fault => {
  const f = fixture(); f.setState({ ...f.state, nativeRecordingVersion: 2 }, false);
  const backend = await f.connect();
  try {
    await backend.listEncounters(backend.signal);
    const mount = await backend.openEncounter(appointment, backend.signal);
    f.plugin.providerRequest.mockImplementationOnce(async request => {
      const body = JSON.parse(request.body) as { request_nonce: string };
      return f.reply(request, { revision: request.revision, session_id: fault === "session" ? crypto.randomUUID() : session,
        authorization_id: fault === "nonce" ? crypto.randomUUID() : body.request_nonce,
        ...(fault === "extra" ? { tenant_id: workspace } : {}) }, fault === "denied" ? 403 : 200);
    });
    await expect(mount.reauthorizeRecorder(session, backend.signal)).rejects.toThrow();
    expect(() => mount.nativeRecording!.open(session, crypto.randomUUID())).toThrow();
    expect(f.plugin.openProviderRecording).not.toHaveBeenCalled();
  } finally { await backend.dispose(); }
});

it("cancels an in-flight native context and cannot adopt its late acknowledgement", async () => {
  const f = fixture(); f.setState({ ...f.state, nativeRecordingVersion: 2 }, false);
  const backend = await f.connect(), abort = new AbortController(), held = deferred<NativeReply>();
  try {
    await backend.listEncounters(backend.signal);
    const mount = await backend.openEncounter(appointment, backend.signal);
    f.plugin.providerRequest.mockImplementationOnce(() => held.promise);
    const pending = mount.reauthorizeRecorder(session, abort.signal), rejected = expect(pending).rejects.toThrow();
    const request = f.plugin.providerRequest.mock.calls.at(-1)![0];
    abort.abort(); await rejected; held.resolve(f.reply(request)); await Promise.resolve();
    expect(f.plugin.cancelProviderRequest).toHaveBeenCalledWith({ requestId: request.requestId });
    expect(() => mount.nativeRecording!.open(session, crypto.randomUUID())).toThrow();
  } finally { await backend.dispose(); }
});
