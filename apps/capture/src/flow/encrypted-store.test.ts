import { webcrypto } from "node:crypto";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { MockCaptureService } from "../mock-bff/state";
import { EncryptedIndexedDbFlowStore } from "./encrypted-store";
import {
  beginRecoverySegment,
  createCaptureRecoveryState,
  observeRecoveryGap,
} from "./recovery-state";
import { createWrappedSessionKey } from "./session-key";
import type { ReservationIntent } from "./types";

const TEST_CRYPTO = webcrypto as unknown as Crypto;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "99999999-9999-4999-8999-999999999999";

describe("EncryptedIndexedDbFlowStore", () => {
  it("preserves an exact preparation mutation body and rejects rewrites", async () => {
    const indexedDB = new IDBFactory();
    const store = await EncryptedIndexedDbFlowStore.open({
      indexedDB,
      databaseName: TEST_CRYPTO.randomUUID(),
      crypto: TEST_CRYPTO,
    });
    const preparation = {
      schemaVersion: 2 as const,
      startedAt: "2026-08-18T12:00:00.000Z",
      consentIdempotencyKey: "consent-session-0001",
      completeIdempotencyKey: "complete-session-0001",
      consentRequest: {
        appointment_id: "synthetic-appointment",
        practitioner_id: "synthetic-practitioner",
        patient_id: "synthetic-patient",
        modality: "in_person" as const,
        method: "verbal_attestation" as const,
        all_parties_consented: true,
        participant_regions: ["US-NY"],
        granted_at: "2026-08-18T12:00:00.000Z",
        evidence_object_id: null,
      },
      consentId: null,
      sessionIdempotencyKey: null,
      sessionRequest: null,
      sessionId: null,
      leaseIdempotencyKey: null,
      leaseRequest: null,
    };
    await store.putPreparationState(preparation);
    await expect(store.getPreparationState()).resolves.toEqual(preparation);
    await store.putPreparationState({
      ...preparation,
      consentId: "44444444-4444-4444-8444-444444444444",
    });
    await expect(store.putPreparationState({
      ...preparation,
      consentRequest: { ...preparation.consentRequest, patient_id: "changed" },
    })).rejects.toThrow("preparation_state_conflict");
    store.close();
  });

  it("persists and clears the metadata-only active capture fence", async () => {
    const indexedDB = new IDBFactory();
    const store = await EncryptedIndexedDbFlowStore.open({
      indexedDB,
      databaseName: TEST_CRYPTO.randomUUID(),
      crypto: TEST_CRYPTO,
    });
    const active = {
      schemaVersion: 2 as const,
      sessionId: SESSION_ID,
      lease: {
        protocol_version: "1.0" as const,
        receipt_id: "22222222-2222-4222-8222-222222222222",
        lease_id: "33333333-3333-4333-8333-333333333333",
        session_id: SESSION_ID,
        generation: 1,
        issued_at: "2026-08-18T12:00:00.000Z",
        expires_at: "2026-08-18T12:15:00.000Z",
      },
      captureAuthorizedUntil: null,
      aggregatePlaintextBudgetBytes: 67_108_864,
      phase: "ready" as const,
      completeIdempotencyKey: "complete-session-0001",
      recordedChunks: 0,
      recordedPlaintextBytes: 0,
      startedAt: "2026-08-18T12:00:00.000Z",
    };
    await store.putActiveCaptureState(active);
    await store.putCaptureRecoveryState(createCaptureRecoveryState(SESSION_ID));
    await store.putCaptureRecoveryState(createCaptureRecoveryState(OTHER_SESSION_ID));
    await expect(store.getActiveCaptureState()).resolves.toEqual(active);
    await store.putActiveCaptureState({ ...active, phase: "uploading", recordedChunks: 1 });
    await expect(store.getActiveCaptureState()).resolves.toMatchObject({
      phase: "uploading",
      recordedChunks: 1,
    });
    await store.putActiveCaptureState({
      ...active,
      phase: "paused",
      recordedChunks: 1,
      captureAuthorizedUntil: "2026-08-18T12:15:00.000Z",
    });
    await expect(store.putActiveCaptureState({
      ...active,
      phase: "paused",
      recordedChunks: 1,
      captureAuthorizedUntil: "2026-08-18T12:14:59.000Z",
    })).rejects.toThrow("active_capture_conflict");
    await store.clearCompletedCapture(SESSION_ID);
    await expect(store.getActiveCaptureState()).resolves.toBeNull();
    await expect(store.getCaptureRecoveryState(SESSION_ID)).resolves.toBeNull();
    await expect(store.getCaptureRecoveryState(OTHER_SESSION_ID)).resolves.toMatchObject({
      sessionId: OTHER_SESSION_ID,
    });
    store.close();
  });

  it("stores recovery metadata as authenticated ciphertext and isolates its session", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = TEST_CRYPTO.randomUUID();
    const store = await EncryptedIndexedDbFlowStore.open({
      indexedDB, databaseName, crypto: TEST_CRYPTO,
    });
    const state = createCaptureRecoveryState(SESSION_ID);

    await store.putCaptureRecoveryState(state);
    await store.putCaptureRecoveryState(state);
    expect(await store.getCaptureRecoveryState(SESSION_ID)).toEqual(state);
    await expect(store.getCaptureRecoveryState(
      OTHER_SESSION_ID,
    )).resolves.toBeNull();

    const raw = await readRecoveryRawRecord(indexedDB, databaseName);
    expect(Object.keys(raw).sort()).toEqual([
      "ciphertext", "key", "nonce", "recordRevision",
    ]);
    expect(raw).toMatchObject({
      key: expect.stringMatching(/^recovery:[A-Za-z0-9_-]{43}$/u),
      recordRevision: 1,
    });
    expect(JSON.stringify(raw)).not.toContain(SESSION_ID);
    store.close();
  });

  it("serializes concurrent revisions and rejects divergent stale writes", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = TEST_CRYPTO.randomUUID();
    const first = await EncryptedIndexedDbFlowStore.open({
      indexedDB, databaseName, crypto: TEST_CRYPTO,
    });
    const second = await EncryptedIndexedDbFlowStore.open({
      indexedDB, databaseName, crypto: TEST_CRYPTO,
    });
    const initial = createCaptureRecoveryState(SESSION_ID);
    await first.putCaptureRecoveryState(initial);
    const left = beginRecoverySegment(initial, {
      segmentId: "22222222-2222-4222-8222-222222222222",
      recoveryGapId: "33333333-3333-4333-8333-333333333333",
      startedAt: "2026-09-02T12:00:00.000Z",
      leaseGeneration: 1,
      captureAuthorizedUntil: "2026-09-02T12:15:00.000Z",
    });
    const right = beginRecoverySegment(initial, {
      ...left.segments[0]!,
      segmentId: "44444444-4444-4444-8444-444444444444",
      recoveryGapId: "55555555-5555-4555-8555-555555555555",
    });

    const outcomes = await Promise.allSettled([
      first.putCaptureRecoveryState(left),
      second.putCaptureRecoveryState(right),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(first.putCaptureRecoveryState(
      await first.getCaptureRecoveryState(SESSION_ID) as typeof left,
    )).resolves.toBeUndefined();
    first.close();
    second.close();
  });

  it("rejects recovery revision and ciphertext tampering", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = TEST_CRYPTO.randomUUID();
    const store = await EncryptedIndexedDbFlowStore.open({
      indexedDB, databaseName, crypto: TEST_CRYPTO,
    });
    const initial = createCaptureRecoveryState(SESSION_ID);
    const recording = beginRecoverySegment(initial, {
      segmentId: "22222222-2222-4222-8222-222222222222",
      recoveryGapId: "33333333-3333-4333-8333-333333333333",
      startedAt: "2026-09-02T12:00:00.000Z",
      leaseGeneration: 1,
      captureAuthorizedUntil: "2026-09-02T12:15:00.000Z",
    });
    const closing = observeRecoveryGap(recording, {
      reasonCode: "capture_backgrounded",
      observedAt: "2026-09-02T12:01:00.000Z",
      nextSequenceNumber: 1,
    });
    await store.putCaptureRecoveryState(initial);
    await store.putCaptureRecoveryState(recording);
    await store.putCaptureRecoveryState(closing);

    const raw = await readRecoveryRawRecord(indexedDB, databaseName);
    await writeRawRecord(indexedDB, databaseName, { ...raw, recordRevision: 99 });
    await expect(store.getCaptureRecoveryState(SESSION_ID)).rejects.toThrow(
      "encrypted_flow_store_integrity_failure",
    );
    const ciphertext = (raw.ciphertext as ArrayBuffer).slice(0);
    const ciphertextBytes = new Uint8Array(ciphertext);
    const firstByte = ciphertextBytes[0];
    if (firstByte === undefined) throw new Error("ciphertext missing");
    ciphertextBytes[0] = firstByte ^ 1;
    await writeRawRecord(indexedDB, databaseName, { ...raw, ciphertext });
    await expect(store.getCaptureRecoveryState(SESSION_ID)).rejects.toThrow(
      "encrypted_flow_store_integrity_failure",
    );
    store.close();
  });

  it("persists the exact reservation intent before a mutation and reopens it", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = TEST_CRYPTO.randomUUID();
    const intent = testIntent();
    let store = await EncryptedIndexedDbFlowStore.open({
      indexedDB,
      databaseName,
      crypto: TEST_CRYPTO,
    });
    await store.putReservationIntent(intent);
    store.close();

    store = await EncryptedIndexedDbFlowStore.open({
      indexedDB,
      databaseName,
      crypto: TEST_CRYPTO,
    });
    await expect(store.listReservationIntents()).resolves.toEqual([intent]);
    await expect(store.putReservationIntent({
      ...intent,
      request: { ...intent.request, count: 2 },
    })).rejects.toThrow("flow_record_conflict");
    await store.deleteReservationIntent(intent.intentId);
    await expect(store.listReservationIntents()).resolves.toEqual([]);
    store.close();
  });

  it("persists a non-extractable DEK and its replayable bind state", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = TEST_CRYPTO.randomUUID();
    const wrapped = await createWrappedSessionKey(
      new MockCaptureService({ requirePreparation: false }).audioEncryptionKey(),
      TEST_CRYPTO,
    );
    const store = await EncryptedIndexedDbFlowStore.open({
      indexedDB,
      databaseName,
      crypto: TEST_CRYPTO,
    });
    await store.putSessionKeyCandidate({
      schemaVersion: 2,
      sessionId: SESSION_ID,
      keyVersion: wrapped.keyVersion,
      wrappedDek: wrapped.wrappedDek,
      idempotencyKey: "bind-session-key-0001",
      state: "pending",
    }, wrapped.key);

    const restoredKey = await store.getSessionKey(SESSION_ID);
    expect(restoredKey).toMatchObject({
      extractable: false,
      type: "secret",
      usages: ["encrypt"],
    });
    await expect(store.getSessionKeyState(SESSION_ID)).resolves.toMatchObject({
      state: "pending",
      keyVersion: wrapped.keyVersion,
    });
    await store.markSessionKeyBound(SESSION_ID);
    await expect(store.getSessionKeyState(SESSION_ID)).resolves.toMatchObject({ state: "bound" });
    store.close();
  });
});

function testIntent(): ReservationIntent {
  return {
    schemaVersion: 2,
    intentId: "microphone:0",
    sessionId: SESSION_ID,
    idempotencyKey: "reservation-intent-0001",
    createdAt: "2026-08-18T12:00:00.000Z",
    request: {
      protocol_version: "1.0",
      capture_lease_id: "22222222-2222-4222-8222-222222222222",
      capture_lease_generation: 1,
      channel: "microphone",
      first_sequence_number: 0,
      count: 1,
    },
  };
}

async function readRecoveryRawRecord(
  indexedDB: IDBFactory,
  databaseName: string,
): Promise<Record<string, unknown>> {
  const database = await requestResult(indexedDB.open(databaseName));
  const transaction = database.transaction("encrypted-flow-records", "readonly");
  const values = await requestResult(transaction.objectStore("encrypted-flow-records").getAll());
  database.close();
  const value = values.find((candidate) =>
    typeof candidate === "object" && candidate !== null && "recordRevision" in candidate);
  if (typeof value !== "object" || value === null) throw new Error("raw record missing");
  return value as Record<string, unknown>;
}

async function writeRawRecord(
  indexedDB: IDBFactory,
  databaseName: string,
  value: Record<string, unknown>,
): Promise<void> {
  const database = await requestResult(indexedDB.open(databaseName));
  const transaction = database.transaction("encrypted-flow-records", "readwrite");
  transaction.objectStore("encrypted-flow-records").put(value);
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  database.close();
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}
