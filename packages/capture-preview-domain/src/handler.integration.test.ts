import { createHash } from "node:crypto";

import {
  MAX_ENVELOPE_BYTES,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  base64UrlEncode,
  encodeEnvelope,
} from "@cosmaneura-scribe/capture-protocol";
import { describe, expect, it } from "vitest";

import { PreviewCaptureDomain } from "./domain";
import { createPreviewRequestHandler } from "./handler";
import { InMemoryPreviewRepository } from "./repository";

const ORIGIN = "https://preview.example.test";
const COOKIE_VALUE = "a".repeat(43);

describe("persistent synthetic capture preview", () => {
  it("survives a new process facade and completes upload, registration, and transcript", async () => {
    const repository = new InMemoryPreviewRepository();
    const firstProcess = handler(repository);
    const bootstrap = await firstProcess(request("/api/capture/preview/bootstrap", { method: "POST" }));
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toEqual({
      mode: "synthetic",
      microphone_enabled: false,
      max_chunks: 6,
    });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBe(`__Host-capture_preview=${COOKIE_VALUE}`);

    // A fresh domain and handler represent a cold start/new Function instance.
    const secondProcess = handler(repository);
    const key = await json(secondProcess, "GET", "/api/capture/audio-encryption-key", cookie);
    expect(key.status).toBe(200);
    expect(key.body).toMatchObject({
      key_version: "synthetic-wrapping-key-v1",
      algorithm: "RSA-OAEP-256",
      public_jwk: { kty: "RSA", e: "AQAB", key_ops: ["wrapKey"] },
    });
    expect(JSON.stringify(key.body)).not.toContain('"d"');
    const publicJwk = (key.body as { public_jwk: { n: string } }).public_jwk;
    expect(Buffer.from(publicJwk.n, "base64url")).toHaveLength(384);
    expect(Object.keys((key.body as { public_jwk: object }).public_jwk).sort()).toEqual([
      "alg",
      "e",
      "ext",
      "key_ops",
      "kty",
      "n",
    ]);

    const consentRequest = {
      appointment_id: "synthetic-appointment",
      practitioner_id: "synthetic-practitioner",
      patient_id: "synthetic-patient",
      modality: "in_person",
      method: "verbal_attestation",
      all_parties_consented: true,
      participant_regions: ["US-NY"],
      granted_at: "2026-08-19T12:00:00.000Z",
      evidence_object_id: null,
    };
    const consent = await json(
      secondProcess,
      "POST",
      "/api/capture/consents",
      cookie,
      consentRequest,
      "preview-consent-0001",
    );
    expect(consent.status).toBe(201);
    const consentId = field(consent.body, "id");

    const concurrentReplay = await Promise.all([
      json(
        secondProcess,
        "POST",
        "/api/capture/sessions",
        cookie,
        {
          appointment_id: "synthetic-appointment",
          practitioner_id: "synthetic-practitioner",
          patient_id: "synthetic-patient",
          consent_record_id: consentId,
          modality: "in_person",
        },
        "preview-session-0001",
      ),
      json(
        secondProcess,
        "POST",
        "/api/capture/sessions",
        cookie,
        {
          appointment_id: "synthetic-appointment",
          practitioner_id: "synthetic-practitioner",
          patient_id: "synthetic-patient",
          consent_record_id: consentId,
          modality: "in_person",
        },
        "preview-session-0001",
      ),
    ]);
    expect(concurrentReplay.map((result) => result.status)).toEqual([201, 201]);
    expect(concurrentReplay[1]?.body).toEqual(concurrentReplay[0]?.body);
    const sessionId = field(concurrentReplay[0]?.body, "id");

    expect((await json(
      secondProcess,
      "POST",
      "/api/capture/sessions",
      cookie,
      {
        appointment_id: "synthetic-appointment",
        practitioner_id: "synthetic-practitioner",
        patient_id: "synthetic-patient",
        consent_record_id: consentId,
        modality: "remote",
      },
      "preview-session-0001",
    )).status).toBe(409);

    expect((await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/audio-key`,
      cookie,
      { key_version: "synthetic-wrapping-key-v1", wrapped_dek: "a".repeat(512) },
      "preview-bind-key-0001",
    )).status).toBe(201);
    const capabilities = await json(
      secondProcess,
      "GET",
      `/api/capture/sessions/${sessionId}/capture-capabilities`,
      cookie,
    );
    expect(capabilities.body).toMatchObject({
      max_chunks: 6,
      max_reservations_per_batch: 6,
      protocol_version: PROTOCOL_VERSION,
    });
    const lease = await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/capture-lease`,
      cookie,
      { protocol_version: PROTOCOL_VERSION },
      "preview-lease-00001",
    );
    const leaseId = field(lease.body, "lease_id");
    const generation = numberField(lease.body, "generation");
    const batch = await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/chunk-reservations`,
      cookie,
      {
        protocol_version: PROTOCOL_VERSION,
        capture_lease_id: leaseId,
        capture_lease_generation: generation,
        channel: "microphone",
        first_sequence_number: 0,
        count: 1,
      },
      "preview-reserve-0001",
    );
    const reservation = arrayField(batch.body, "reservations")[0];
    const objectId = field(reservation, "object_id");
    const authorization = await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/chunks/${objectId}/upload-authorization`,
      cookie,
      { protocol_version: PROTOCOL_VERSION },
      "preview-authorize-001",
    );
    const authorizationReplay = await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/chunks/${objectId}/upload-authorization`,
      cookie,
      { protocol_version: PROTOCOL_VERSION },
      "preview-authorize-001",
    );
    expect(authorizationReplay).toEqual(authorization);
    const uploadUrl = field(authorization.body, "upload_url");
    expect(uploadUrl).toMatch(/^\/api\/capture\/preview\/uploads\/[0-9a-f]{64}\//u);

    const envelope = syntheticEnvelope();
    const parsedUpload = new URL(uploadUrl, ORIGIN);
    const receiptId = parsedUpload.hash.slice("#receipt=".length);
    parsedUpload.hash = "";
    const wrongOriginUpload = await secondProcess(
      new Request(`${ORIGIN}${parsedUpload.pathname}`, {
        method: "PUT",
        headers: {
          Origin: "https://wrong.example.test",
          "Content-Type": "application/octet-stream",
          "X-Capture-Upload-Receipt": receiptId,
        },
        body: envelope.slice().buffer,
      }),
    );
    expect(wrongOriginUpload.status).toBe(403);
    expect((await secondProcess(
      request(parsedUpload.pathname, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Capture-Upload-Receipt": "99999999-9999-4999-8999-999999999999",
        },
        body: envelope.slice().buffer,
      }),
    )).status).toBe(403);
    expect((await secondProcess(
      request(parsedUpload.pathname, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Capture-Upload-Receipt": receiptId,
        },
        body: new Uint8Array([1, 2, 3]).buffer,
      }),
    )).status).toBe(422);
    expect((await secondProcess(
      request(parsedUpload.pathname, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Capture-Upload-Receipt": receiptId,
        },
        body: new Uint8Array(MAX_ENVELOPE_BYTES + 1).buffer,
      }),
    )).status).toBe(413);
    const upload = await secondProcess(
      request(`${parsedUpload.pathname}${parsedUpload.search}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Capture-Upload-Receipt": receiptId,
        },
        body: envelope.slice().buffer,
      }),
    );
    expect(upload.status).toBe(201);
    const sha256 = createHash("sha256").update(envelope).digest("hex");
    const registration = await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/chunks`,
      cookie,
      {
        object_id: objectId,
        channel: "microphone",
        sequence_number: 0,
        sha256,
        ciphertext_size_bytes: envelope.byteLength,
      },
      "preview-register-0001",
    );
    expect(registration.status).toBe(201);
    await expect(repository.readEnvelope(
      parsedUpload.pathname.split("/")[5] ?? "",
      objectId,
    )).resolves.toBeNull();
    expect((await secondProcess(
      request(parsedUpload.pathname, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Capture-Upload-Receipt": receiptId,
        },
        body: envelope.slice().buffer,
      }),
    )).status).toBe(409);
    expect((await json(
      secondProcess,
      "GET",
      `/api/capture/sessions/${sessionId}/chunks/${objectId}`,
      cookie,
    )).body).toMatchObject({ state: "registered" });

    const complete = await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/capture-complete`,
      cookie,
      {
        protocol_version: PROTOCOL_VERSION,
        capture_lease_id: leaseId,
        capture_lease_generation: generation,
        channels: [{ channel: "microphone", final_sequence_number: 0 }],
      },
      "preview-complete-0001",
    );
    expect(complete.body).toMatchObject({ status: "uploaded" });
    expect((await json(
      secondProcess,
      "GET",
      `/api/capture/sessions/${sessionId}/transcription-status`,
      cookie,
    )).body).toMatchObject({ status: "completed", transcript_available: true });
    expect((await json(
      secondProcess,
      "GET",
      `/api/capture/sessions/${sessionId}/transcript`,
      cookie,
    )).body).toMatchObject({ stt_provider: "synthetic-preview" });
    const scopeId = parsedUpload.pathname.split("/")[5] ?? "";
    const stored = await repository.readScope(scopeId);
    expect(stored).not.toBeNull();
    const serializedState = JSON.stringify(stored?.state);
    expect(Buffer.byteLength(serializedState, "utf8")).toBeLessThan(100_000);
    expect(serializedState).not.toContain("preview-consent-0001");
    expect(serializedState).not.toContain(receiptId);
    expect(serializedState).not.toContain(uploadUrl);
    expect(new Set(Object.values(stored?.state.audit ?? {}).map((event) => event.operation))).toEqual(
      new Set([
        "bootstrap",
        "consent",
        "session",
        "bind-key",
        "issue-lease",
        "reserve",
        "authorize",
        "upload",
        "register",
        "complete",
      ]),
    );

    expect((await json(
      secondProcess,
      "POST",
      "/api/capture/consents",
      cookie,
      consentRequest,
      "preview-consent-after-close",
    )).status).toBe(409);
    expect((await json(
      secondProcess,
      "POST",
      "/api/capture/sessions",
      cookie,
      {
        appointment_id: "synthetic-appointment",
        practitioner_id: "synthetic-practitioner",
        patient_id: "synthetic-patient",
        consent_record_id: consentId,
        modality: "in_person",
      },
      "preview-session-after-close",
    )).status).toBe(409);
    expect((await json(
      secondProcess,
      "POST",
      `/api/capture/sessions/${sessionId}/audio-key`,
      cookie,
      { key_version: "synthetic-wrapping-key-v1", wrapped_dek: "a".repeat(512) },
      "preview-bind-after-close",
    )).status).toBe(409);
  });

  it("isolates scopes by effective host and cookie and rejects unbootstrapped control calls", async () => {
    const repository = new InMemoryPreviewRepository();
    const handle = createPreviewRequestHandler(new PreviewCaptureDomain(repository), {
      allowedHosts: ["preview.example.test", "other.example.test"],
      cookieFactory: () => COOKIE_VALUE,
    });
    const health = await handle(request("/api/capture/preview/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", mode: "synthetic" });
    await handle(request("/api/capture/preview/bootstrap", { method: "POST" }));

    expect((await handle(request("/api/capture/audio-encryption-key"))).status).toBe(401);
    expect((await handle(request("/api/capture/audio-encryption-key", {
      headers: { Cookie: `__Host-capture_preview=${COOKIE_VALUE}` },
      origin: "https://other.example.test",
    }))).status).toBe(401);
  });

  it("strictly rejects unknown fields and non-synthetic identifiers", async () => {
    const repository = new InMemoryPreviewRepository();
    const handle = handler(repository);
    const bootstrap = await handle(request("/api/capture/preview/bootstrap", { method: "POST" }));
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    const result = await json(
      handle,
      "POST",
      "/api/capture/consents",
      cookie,
      {
        appointment_id: "real-appointment",
        practitioner_id: "synthetic-practitioner",
        patient_id: "synthetic-patient",
        modality: "in_person",
        method: "verbal_attestation",
        all_parties_consented: true,
        participant_regions: ["US-NY"],
        granted_at: "2026-08-19T12:00:00.000Z",
        evidence_object_id: null,
        unexpected: true,
      },
      "preview-consent-0001",
    );
    expect(result.status).toBe(422);
    expect(result.body).toEqual({
      detail: {
        code: "request_invalid",
        message: "synthetic preview request rejected",
      },
    });
  });

  it("uses the canonical x-ms original SWA URL and rejects direct Function hosts", async () => {
    const repository = new InMemoryPreviewRepository();
    const handle = handler(repository);
    const proxied = new Request(
      "https://function.azurewebsites.net/api/capture/preview/bootstrap",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "X-Ms-Original-Url": `${ORIGIN}/api/capture/preview/bootstrap`,
        },
      },
    );
    expect((await handle(proxied)).status).toBe(200);

    const direct = new Request(
      "https://function.azurewebsites.net/api/capture/preview/bootstrap",
      { method: "POST", headers: { Origin: "https://function.azurewebsites.net" } },
    );
    expect((await handle(direct)).status).toBe(403);
  });

  it("requires an exact same-origin Origin on bootstrap and upload mutations", async () => {
    const repository = new InMemoryPreviewRepository();
    const handle = handler(repository);
    expect((await handle(new Request(`${ORIGIN}/api/capture/preview/bootstrap`, {
      method: "POST",
    }))).status).toBe(403);
  });

  it("caps new anonymous scopes per UTC day while allowing an existing scope to refresh", async () => {
    const repository = new InMemoryPreviewRepository();
    const cookies = ["a".repeat(43), "b".repeat(43), "c".repeat(43)];
    let index = 0;
    const handle = createPreviewRequestHandler(
      new PreviewCaptureDomain(repository, { maxNewScopesPerDay: 2 }),
      {
        allowedHosts: ["preview.example.test"],
        cookieFactory: () => cookies[index++] ?? "z".repeat(43),
      },
    );
    const first = await handle(request("/api/capture/preview/bootstrap", { method: "POST" }));
    expect(first.status).toBe(200);
    expect((await handle(request(
      "/api/capture/preview/bootstrap",
      { method: "POST" },
    ))).status).toBe(200);
    expect((await handle(request(
      "/api/capture/preview/bootstrap",
      { method: "POST" },
    ))).status).toBe(429);

    const firstCookie = first.headers.get("set-cookie")?.split(";", 1)[0];
    expect((await handle(request("/api/capture/preview/bootstrap", {
      method: "POST",
      headers: firstCookie === undefined ? {} : { Cookie: firstCookie },
    }))).status).toBe(200);
  });

  it("stops reading a bootstrap body as soon as its zero-byte route limit is exceeded", async () => {
    const repository = new InMemoryPreviewRepository();
    const handle = handler(repository);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array(1_000_000));
      },
    });
    const response = await handle(new Request(`${ORIGIN}/api/capture/preview/bootstrap`, {
      method: "POST",
      headers: { Origin: ORIGIN },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(response.status).toBe(413);
  });
});

function handler(repository: InMemoryPreviewRepository) {
  return createPreviewRequestHandler(new PreviewCaptureDomain(repository), {
    allowedHosts: ["preview.example.test"],
    cookieFactory: () => COOKIE_VALUE,
  });
}

function request(
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: BodyInit;
    readonly origin?: string;
  } = {},
): Request {
  const origin = options.origin ?? ORIGIN;
  return new Request(new URL(path, origin), {
    method: options.method ?? "GET",
    headers: { Origin: origin, ...options.headers },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

async function json(
  handle: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await handle(request(path, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json() };
}

function field(value: unknown, name: string): string {
  if (typeof value !== "object" || value === null || !(name in value)) {
    throw new Error(`missing ${name}`);
  }
  const fieldValue = (value as Record<string, unknown>)[name];
  if (typeof fieldValue !== "string") throw new Error(`invalid ${name}`);
  return fieldValue;
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "object" || value === null || !(name in value)) {
    throw new Error(`missing ${name}`);
  }
  const fieldValue = (value as Record<string, unknown>)[name];
  if (typeof fieldValue !== "number") throw new Error(`invalid ${name}`);
  return fieldValue;
}

function arrayField(value: unknown, name: string): unknown[] {
  if (typeof value !== "object" || value === null || !(name in value)) {
    throw new Error(`missing ${name}`);
  }
  const fieldValue = (value as Record<string, unknown>)[name];
  if (!Array.isArray(fieldValue)) throw new Error(`invalid ${name}`);
  return fieldValue;
}

function syntheticEnvelope(): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.fill(7);
  const ciphertextAndTag = new Uint8Array(48);
  ciphertextAndTag.fill(11);
  return encodeEnvelope(
    {
      schema_version: PROTOCOL_VERSION,
      content_encryption: "A256GCM",
      nonce: base64UrlEncode(nonce),
      media_type: "audio/wav",
    },
    ciphertextAndTag,
  );
}
