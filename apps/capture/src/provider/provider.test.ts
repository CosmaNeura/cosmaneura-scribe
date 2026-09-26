import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpCreatorReviewApi } from "../../../review-ui/src/creator-review-api";
import { CoreCaptureClient, CoreCaptureBff, type AdmissionIntent, type CoreCaptureScope, type AuthorizedCoreRequest } from "./core-client";
import { canonical, parseDraft, pendingSave, resolveNote, saveNote, sha256, type CoreDraft } from "./core-notes";
import { NativeProviderWorkspaceJournal, assertProgress, type ProviderProgress } from "./workspace-journal";

const uuid = "10000000-0000-4000-8000-000000000001";
const scope: CoreCaptureScope = { workspaceId: uuid, appointmentRef: "appointment_01j00000000000000000000000",
  bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
const source = { kind: "reviewed_english" as const, source_version: 1, working_transcript_id: uuid, working_version: 2 };
const schema = "doctor_note_schema_01j00000000000000000000000";
const noteRef = "visit_note_01j00000000000000000000000";
const resultRef = "visit_note_01j00000000000000000000001";
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });

function wire(receipt: unknown, override: Record<string, unknown> = {}): AuthorizedCoreRequest {
  return (_path, body) => Promise.resolve(Response.json({ contract_version: "1", ...body, receipt,
    operation: (body.operation as { kind?: string })?.kind, checked_at: new Date().toISOString(), ...override }));
}
async function base(): Promise<CoreDraft> {
  const fields = { CC: "Invented complaint", Plan: "Discussed follow-up" };
  return { session_id: uuid, scribe_source_id: uuid, source_sha256: "a".repeat(64), schema_ref: schema,
    transcript_ref: "ai_visit_transcript_01j00000000000000000000000", note_ref: noteRef,
    status: "draft", note_type: "Synthetic SOAP", fields, field_order: ["CC", "Plan"],
    note_sha256: await sha256(JSON.stringify(Object.entries(fields))), created_at: new Date().toISOString(),
    review_required: true, reviewed_source: source };
}

describe("configured Core provider boundary", () => {
  it("discovers the admitted session without inventing consent or selecting a session", async () => {
    const view = { schema_version: "1.0", session_id: uuid, status: "processing", source: null, working: null, review_queue: null };
    const send = vi.fn(wire({ schema_version: "1.0", status: "available", review: view }));
    const client = new CoreCaptureClient(scope, send, new AbortController().signal);
    expect(await client.discoverEncounter()).toMatchObject(view);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].operation).toEqual({ kind: "provider_encounter" });
    expect(Object.keys(send.mock.calls[0]![1]).sort()).toEqual(["binding_ref", "operation", "request_nonce", "workspace_id"]);
    expect(await new CoreCaptureClient(scope, wire({ schema_version: "1.0", status: "not_prepared", review: null }),
      new AbortController().signal).discoverEncounter()).toBeNull();
  });
  it.each([409, 403, 503])("never mistakes failed discovery (%s) for a new encounter", async status => {
    const client = new CoreCaptureClient(scope, async () => new Response(null, { status }), new AbortController().signal);
    await expect(client.discoverEncounter()).rejects.toThrow();
  });
  it.each([
    { schema_version: "1.0", status: "available", review: null },
    { schema_version: "1.0", status: "not_prepared", review: { session_id: uuid } },
    { schema_version: "1.0", status: "not_prepared", review: null, extra: true },
  ])("rejects malformed discovery", async receipt => {
    await expect(new CoreCaptureClient(scope, wire(receipt), new AbortController().signal).discoverEncounter()).rejects.toThrow();
  });
  it("recovers without replaying stale consent and preserves the retained intent on explicit renewal", async () => {
    const intent: AdmissionIntent = { key: crypto.randomUUID(), languageMode: "en-US", attestation: {
      modality: "in_person", participant_regions: ["US"], method: "verbal_attestation", all_parties_consented: true,
      granted_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    } };
    const original = structuredClone(intent), calls: Record<string, unknown>[] = [];
    let committed = false;
    const client = new CoreCaptureClient(scope, async (_path, body, key) => {
      expect(key).toBe(intent.key); calls.push(body);
      if (!committed && body.attestation === null) return Response.json({ detail: "provider_consent_required" }, { status: 409 });
      committed = true;
      return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
        operation_ref: "scribe_admission_01j00000000000000000000000", appointment_ref: scope.appointmentRef,
        consent_record_id: uuid, session_id: uuid });
    }, new AbortController().signal);
    expect(await client.recoverAdmission(intent)).toBeNull();
    expect(await client.renewAdmission(intent)).toBe(uuid);
    expect(Date.parse((calls[1]!.attestation as AdmissionIntent["attestation"]).granted_at)).toBeGreaterThan(Date.parse(intent.attestation.granted_at));
    expect(await client.recoverAdmission(intent)).toBe(uuid);
    expect(calls[0]!.attestation).toBeNull(); expect(calls[2]!.attestation).toBeNull();
    expect(intent).toEqual(original);
  });
  it.each([
    { detail: "provider_request_unconfirmed" },
    { detail: "provider_consent_required", extra: "untrusted" },
  ])("does not treat other conflicts as permission to renew consent", async failure => {
    const client = new CoreCaptureClient(scope, async () => Response.json(failure, { status: 409 }), new AbortController().signal);
    const intent: AdmissionIntent = { key: crypto.randomUUID(), languageMode: "en-US", attestation: {
      modality: "in_person", participant_regions: ["US"], method: "verbal_attestation", all_parties_consented: true,
      granted_at: new Date().toISOString(),
    } };
    await expect(client.recoverAdmission(intent)).rejects.toMatchObject({ code: "core_capture_unconfirmed" });
  });
  it.each(["workspace_id", "binding_ref", "request_nonce", "operation"])("rejects changed %s before returning a receipt", async field => {
    const client = new CoreCaptureClient(scope, wire({ session_id: uuid }, { [field]: "changed" }), new AbortController().signal);
    await expect(client.operation(uuid, { kind: "creator_review" })).rejects.toThrow("capture BFF request failed");
  });
  it("never exposes a late reply after host revocation", async () => {
    const abort = new AbortController();
    const client = new CoreCaptureClient(scope, async (...args) => {
      const result = await wire({ session_id: uuid })(...args); abort.abort(); return result;
    }, abort.signal);
    await expect(client.operation(uuid, { kind: "creator_review" })).rejects.toThrow();
  });
  it.each(["request", "encounter"])("propagates %s cancellation and rejects an uncooperative late reply", async source => {
    const encounter = new AbortController(), request = new AbortController();
    let release!: () => void, sentSignal: AbortSignal | undefined;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const client = new CoreCaptureClient(scope, async (...args) => {
      sentSignal = args[3]; await waiting; return wire({ session_id: uuid })(...args);
    }, encounter.signal);
    const pending = client.operation(uuid, { kind: "capabilities" }, undefined, request.signal);
    const rejected = expect(pending).rejects.toThrow();
    (source === "request" ? request : encounter).abort();
    expect(sentSignal?.aborted).toBe(true);
    release(); await rejected;
    expect((source === "request" ? encounter : request).signal.aborted).toBe(false);
  });
  it("does not dispatch an already-cancelled operation", async () => {
    const request = new AbortController(), send = vi.fn(wire({ session_id: uuid }));
    const client = new CoreCaptureClient(scope, send, new AbortController().signal);
    request.abort();
    await expect(client.operation(uuid, { kind: "capabilities" }, undefined, request.signal)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves review conflicts and forbids legacy creation and source endpoints", async () => {
    const client = new CoreCaptureClient(scope, () => Promise.resolve(new Response(null, { status: 409 })), new AbortController().signal);
    await expect(new HttpCreatorReviewApi(uuid, client.reviewRequest(uuid)).read()).rejects.toMatchObject({ kind: "conflict" });
    const bff = new CoreCaptureBff(client, uuid);
    await expect(bff.createConsent()).rejects.toMatchObject({ code: "core_admission_required" });
    await expect(bff.createSession()).rejects.toMatchObject({ code: "core_admission_required" });
    await expect(bff.getTranscript()).rejects.toMatchObject({ code: "creator_review_required" });
    await expect(bff.getCapabilities("20000000-0000-4000-8000-000000000002")).rejects.toThrow();
  });
  it("binds draft content, field order and reviewed lineage", async () => {
    const draft = await base();
    expect(await parseDraft(draft, uuid, schema, source)).toEqual(draft);
    for (const changed of [ { ...draft, fields: { ...draft.fields, CC: "altered" } },
      { ...draft, field_order: ["Plan", "CC"] }, { ...draft, reviewed_source: { ...source, working_version: 3 } },
      { ...draft, review_required: false }, { ...draft, scribe_source_id: crypto.randomUUID() } ]) {
      await expect(parseDraft(changed, uuid, schema, source)).rejects.toThrow();
    }
  });
  it("verifies saves and resolves only the exact journalled edit before a fresh read", async () => {
    const draft = await base(), fields = { CC: "Edited invented complaint", Plan: "Discussed follow-up" };
    const pending = pendingSave(draft, fields);
    const saved = { ...draft, note_ref: resultRef, fields, note_sha256: await sha256(JSON.stringify(Object.entries(fields))) };
    const client = new CoreCaptureClient(scope, wire(saved), new AbortController().signal);
    expect((await saveNote(client, uuid, pending)).note_ref).toBe(resultRef);
    const receipt = { session_id: uuid, schema_ref: schema, client_key: pending.edit.client_key,
      request_sha256: await sha256(canonical({ edit: pending.edit, schema, session: uuid, workspace: scope.workspaceId })),
      status: "saved", result_note_ref: resultRef, result_sha256: saved.note_sha256 };
    const recover = new CoreCaptureClient(scope, wire(receipt), new AbortController().signal);
    expect(await resolveNote(recover, uuid, pending)).toBe("saved");
    await expect(resolveNote(recover, uuid, { ...pending, edit: { ...pending.edit, client_key: crypto.randomUUID() } })).rejects.toThrow();
    expect(canonical({ "\u{10000}": 1, "\uE000": 2 })).toBe('{"\uE000":2,"\u{10000}":1}');
  });
});

describe("scoped encrypted native journal adapter", () => {
  it("retains uploaded-session recovery without an invented attestation and cannot convert it to recording", async () => {
    let stored: { key: string; data: string; revision: string } | null = null;
    const plugin = {
      get: async () => { if (!stored) throw Object.assign(new Error("Missing synthetic record"), { code: "SECURE_QUEUE_NOT_FOUND" }); return stored; },
      create: async ({ key, data }: { key: string; data: string }) => { stored = { key, data, revision: "1" }; return { revision: "1" }; },
      compareAndSwap: async ({ key, data, expectedRevision }: { key: string; data: string; expectedRevision: string }) => {
        expect(stored?.revision).toBe(expectedRevision); stored = { key, data, revision: "2" }; return { revision: "2" };
      },
    };
    const journal = new NativeProviderWorkspaceJournal(plugin, uuid, scope);
    const recovered: ProviderProgress = { admission: null, sessionId: uuid, uploaded: true, pendingSave: null };
    const saved = await journal.save(await journal.load(), recovered);
    expect((await new NativeProviderWorkspaceJournal(plugin, uuid, scope).load()).progress).toEqual(recovered);
    expect(JSON.parse(atob(stored!.data)).version).toBe(2);
    expect(() => assertProgress({ ...recovered, uploaded: false })).toThrow();
    expect(() => assertProgress({ ...recovered, sessionId: null })).toThrow();
    const pending = pendingSave(await base(), { CC: "Synthetic reopened note", Plan: "Discussed follow-up" });
    await journal.save(saved, { ...recovered, pendingSave: pending });
    expect((await journal.load()).progress?.pendingSave).toEqual(pending);
    const invalid = JSON.parse(atob(stored!.data)); invalid.version = 1; stored!.data = btoa(JSON.stringify(invalid));
    await expect(journal.load()).rejects.toThrow("Encounter recovery is unavailable");
  });
  it("recovers committed writes after lost replies, rejects races and changed scope", async () => {
    const values = new Map<string, { data: string; revision: string }>();
    let lose = false;
    const write = (key: string, data: string, expected: string | null) => {
      const current = values.get(key);
      if ((current?.revision ?? null) !== expected) throw new Error("revision conflict");
      const revision = String(Number(expected ?? 0) + 1); values.set(key, { data, revision });
      if (lose) { lose = false; return Promise.reject(new Error("lost encrypted-store reply")); }
      return Promise.resolve({ revision });
    };
    const plugin = { get: ({ key }: { key: string }) => {
      const value = values.get(key);
      return value ? Promise.resolve({ key, ...value }) : Promise.reject({ code: "SECURE_QUEUE_NOT_FOUND" });
    }, create: ({ key, data }: { key: string; data: string }) => write(key, data, null),
    compareAndSwap: ({ key, data, expectedRevision }: { key: string; data: string; expectedRevision: string }) => write(key, data, expectedRevision) };
    const journal = new NativeProviderWorkspaceJournal(plugin, uuid, scope);
    const initial = await journal.load();
    const progress: ProviderProgress = { admission: { key: crypto.randomUUID(), languageMode: "en-US+es-US", attestation: {
      modality: "in_person", participant_regions: ["US-NY"], method: "verbal_attestation", all_parties_consented: true,
      granted_at: new Date().toISOString() } }, sessionId: null, uploaded: false, pendingSave: null };
    lose = true; await expect(journal.save(initial, progress)).rejects.toThrow("lost encrypted-store reply");
    const recovered = await new NativeProviderWorkspaceJournal(plugin, uuid, scope).load();
    expect(recovered.progress).toEqual(progress);
    await expect(journal.save(initial, progress)).rejects.toThrow("revision conflict");
    await expect(journal.save(recovered, { ...progress, admission: { ...progress.admission, languageMode: "en-US" } })).rejects.toThrow();
    const pending = pendingSave(await base(), { CC: "Señal inventada", Plan: "Discussed follow-up" });
    const saving = await journal.save(recovered, { ...progress, sessionId: uuid, uploaded: true, pendingSave: pending });
    expect((await journal.load()).progress?.pendingSave).toEqual(pending);
    await expect(journal.save(saving, { ...saving.progress!, pendingSave: { ...pending, edit: { ...pending.edit, client_key: crypto.randomUUID() } } })).rejects.toThrow();
    await expect(new NativeProviderWorkspaceJournal(plugin, uuid, { ...scope, appointmentRef: "appointment_01j00000000000000000000001" }).load()).rejects.toThrow("Encounter recovery is unavailable");
  });
});
