import { webcrypto } from "node:crypto";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { MockCaptureService } from "../mock-bff/state";
import { EncryptedIndexedDbFlowStore, assertActiveCaptureState, assertActiveCaptureProgression } from "./encrypted-store";
import { createWrappedSessionKey } from "./session-key";
import type { ActiveCaptureState, ConfiguredCapturePreparationState, ReservationIntent } from "./types";

const TEST_CRYPTO = webcrypto as unknown as Crypto;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("EncryptedIndexedDbFlowStore", () => {
  it("only adopts a server continuation count with its renewed receipt and immutable keys", () => {
    const lease = { protocol_version: "1.0" as const, receipt_id: TEST_CRYPTO.randomUUID(), lease_id: TEST_CRYPTO.randomUUID(),
      session_id: SESSION_ID, generation: 1, issued_at: "2026-09-30T12:00:00.000Z", expires_at: "2026-09-30T12:15:00.000Z" };
    const pending: ActiveCaptureState = { schemaVersion: 7, channel: "mixed", sessionId: SESSION_ID, lease,
      reviewAfterUpload: true, captureAuthorizedUntil: lease.expires_at, aggregatePlaintextBudgetBytes: 402653184,
      phase: "paused", completeIdempotencyKey: "synthetic-complete", recordedChunks: 1, recordedPlaintextBytes: 320044,
      startedAt: lease.issued_at, continuation: { prepared: false, firstSequenceNumber: 1, reservationCount: 0,
        previousLease: lease, renewIdempotencyKey: "synthetic-renew", windowRequest: {
          idempotencyKey: "synthetic-outer", reservationIdempotencyKey: "synthetic-reserve" } } };
    const renewed: ActiveCaptureState = { ...pending, captureAuthorizedUntil: null,
      lease: { ...lease, receipt_id: TEST_CRYPTO.randomUUID(), generation: 2,
        issued_at: "2026-09-30T12:01:00.000Z", expires_at: "2026-09-30T12:16:00.000Z" },
      continuation: { ...pending.continuation!, reservationCount: 90 } };
    const check = (before: ActiveCaptureState, after: ActiveCaptureState) => {
      assertActiveCaptureState(after); assertActiveCaptureProgression(before, after);
    };
    assertActiveCaptureState(pending); check(pending, renewed);
    for (const invalid of [
      { ...pending, phase: "ready" as const },
      { ...pending, schemaVersion: 5 as const },
      { ...pending, continuation: { ...pending.continuation!, prepared: true } },
      { ...pending, continuation: { ...pending.continuation!, reservationCount: 90 } },
      { ...renewed, continuation: { ...renewed.continuation!, windowRequest: {
        ...renewed.continuation!.windowRequest!, idempotencyKey: "replacement-outer" } } },
      { ...renewed, continuation: { ...renewed.continuation!, firstSequenceNumber: 0 } },
      { ...renewed, continuation: { ...renewed.continuation!, reservationCount: 0 } },
      { ...renewed, lease: { ...renewed.lease, generation: 3 } },
      { ...renewed, captureAuthorizedUntil: renewed.lease.expires_at },
    ]) expect(() => check(pending, invalid)).toThrow();
    expect(() => check(renewed, { ...renewed, continuation: { ...renewed.continuation!, reservationCount: 89 } })).toThrow();
  });

  it("retains the first-window recipe across reopen and rejects substituted or erased component keys", async () => {
    const options = { indexedDB: new IDBFactory(), databaseName: TEST_CRYPTO.randomUUID(), crypto: TEST_CRYPTO };
    let store = await EncryptedIndexedDbFlowStore.open(options);
    const initial: ConfiguredCapturePreparationState = { schemaVersion: 6, mode: "configured_core", channel: "mixed",
      sessionId: SESSION_ID, startedAt: "2026-09-30T12:00:00.000Z", completeIdempotencyKey: "synthetic-complete-key",
      leaseIdempotencyKey: null, leaseRequest: null, windowPreparation: null };
    const retained: ConfiguredCapturePreparationState = { ...initial, leaseIdempotencyKey: "synthetic-lease-key",
      leaseRequest: { protocol_version: "1.0" }, windowPreparation: { idempotencyKey: "synthetic-outer-key",
        bindIdempotencyKey: "synthetic-bind-key", reserveIdempotencyKey: "synthetic-reserve-key",
        keyVersion: "synthetic", wrappedDek: "A".repeat(512), reservationCount: 90, aggregatePlaintextBudgetBytes: 402653184 } };
    await store.putPreparationState(initial); await store.putPreparationState(retained); store.close();
    store = await EncryptedIndexedDbFlowStore.open(options);
    try {
      expect(await store.getPreparationState()).toEqual(retained);
      for (const changed of [
        { ...retained, windowPreparation: null },
        { ...retained, windowPreparation: { ...retained.windowPreparation!, idempotencyKey: "replacement-outer-key" } },
        { ...retained, windowPreparation: { ...retained.windowPreparation!, bindIdempotencyKey: "replacement-bind-key" } },
        { ...retained, windowPreparation: { ...retained.windowPreparation!, reserveIdempotencyKey: "replacement-reserve-key" } },
        { ...retained, windowPreparation: { ...retained.windowPreparation!, reservationCount: 89 } },
        { ...retained, windowPreparation: { ...retained.windowPreparation!, aggregatePlaintextBudgetBytes: 300000000 } },
        { ...retained, windowPreparation: { ...retained.windowPreparation!, wrappedDek: "B".repeat(512) } },
        { ...retained, leaseIdempotencyKey: "replacement-lease-key" },
        { ...retained, schemaVersion: 3 as const },
      ]) await expect(store.putPreparationState(changed)).rejects.toThrow();
      for (const key of ["idempotencyKey", "bindIdempotencyKey", "reserveIdempotencyKey"] as const) {
        await expect(store.putPreparationState({ ...retained,
          windowPreparation: { ...retained.windowPreparation!, [key]: retained.leaseIdempotencyKey! } })).rejects.toThrow();
      }
      expect(await store.getPreparationState()).toEqual(retained);
    } finally { store.close(); }
  });

  it("limits continuous renewal to ordered receipts and retains the old deadline until reservations arrive", () => {
    const lease = { protocol_version: "1.0" as const, receipt_id: TEST_CRYPTO.randomUUID(),
      lease_id: TEST_CRYPTO.randomUUID(), session_id: SESSION_ID, generation: 1,
      issued_at: "2026-09-27T12:00:00.000Z", expires_at: "2026-09-27T12:15:00.000Z" };
    const active: ActiveCaptureState = { schemaVersion: 3, channel: "mixed", sessionId: SESSION_ID, lease,
      reviewAfterUpload: true, captureAuthorizedUntil: lease.expires_at, aggregatePlaintextBudgetBytes: 402653184,
      phase: "recording", completeIdempotencyKey: "continuity-complete", recordedChunks: 78,
      recordedPlaintextBytes: 24963432, startedAt: lease.issued_at };
    const pending: ActiveCaptureState = { ...active, schemaVersion: 5,
      continuation: { continuous: true, prepared: false, firstSequenceNumber: 78, reservationCount: 90,
        previousLease: lease, renewIdempotencyKey: "continuity-renew" } };
    const renewed: ActiveCaptureState = { ...pending, recordedChunks: 79, recordedPlaintextBytes: 25283476,
      lease: { ...lease, receipt_id: TEST_CRYPTO.randomUUID(), generation: 2,
        issued_at: "2026-09-27T12:13:00.000Z", expires_at: "2026-09-27T12:28:00.000Z" } };
    const reserved = { ...renewed, captureAuthorizedUntil: renewed.lease.expires_at };
    const prepared = { ...reserved, continuation: { ...pending.continuation!, prepared: true } };
    const check = (before: ActiveCaptureState, after: ActiveCaptureState) => {
      assertActiveCaptureState(after); assertActiveCaptureProgression(before, after);
    };
    check(active, pending); check(pending, renewed); check(renewed, reserved); check(reserved, prepared);
    for (const bad of [
      { ...pending, schemaVersion: 4 as const },
      { ...pending, channel: "microphone" as const },
      { ...pending, captureAuthorizedUntil: null },
      { ...pending, continuation: { ...pending.continuation!, prepared: true } },
      { ...pending, continuation: { ...pending.continuation!, firstSequenceNumber: 79 } },
    ]) expect(() => check(active, bad)).toThrow();
    for (const bad of [
      { ...renewed, lease: { ...renewed.lease, generation: 3 } },
      { ...renewed, lease: { ...renewed.lease, expires_at: lease.expires_at } },
      { ...renewed, lease: { ...renewed.lease, receipt_id: lease.receipt_id } },
      { ...renewed, lease: { ...renewed.lease, lease_id: TEST_CRYPTO.randomUUID() } },
      { ...renewed, captureAuthorizedUntil: renewed.lease.expires_at },
      { ...renewed, recordedChunks: 77 },
      { ...renewed, continuation: { ...pending.continuation!, renewIdempotencyKey: "substituted-renewal" } },
    ]) expect(() => check(pending, bad)).toThrow();
    expect(() => check(reserved, { ...prepared, schemaVersion: 4, continuation: {
      prepared: true, firstSequenceNumber: 78, reservationCount: 90, previousLease: lease, renewIdempotencyKey: "continuity-renew",
    } })).toThrow();
    expect(() => check(prepared, { ...prepared, captureAuthorizedUntil: lease.expires_at })).toThrow();
  });
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
    store.close();
  });

  it("reopens an encrypted continuation beyond one thousand chunks", async () => {
    const options = { indexedDB: new IDBFactory(), databaseName: TEST_CRYPTO.randomUUID(), crypto: TEST_CRYPTO };
    let store = await EncryptedIndexedDbFlowStore.open(options);
    const lease = { protocol_version: "1.0" as const, receipt_id: TEST_CRYPTO.randomUUID(),
      lease_id: TEST_CRYPTO.randomUUID(), session_id: SESSION_ID, generation: 12,
      issued_at: "2026-09-25T14:45:00.000Z", expires_at: "2026-09-25T15:00:00.000Z" };
    const active = { schemaVersion: 4 as const, sessionId: SESSION_ID, lease,
      reviewAfterUpload: true as const, captureAuthorizedUntil: lease.expires_at,
      aggregatePlaintextBudgetBytes: 402653184, phase: "paused" as const,
      completeIdempotencyKey: "long-visit-complete", recordedChunks: 1080,
      recordedPlaintextBytes: 345647520, startedAt: "2026-09-25T12:00:00.000Z",
      continuation: { prepared: false, firstSequenceNumber: 1080, reservationCount: 90,
        previousLease: lease, renewIdempotencyKey: "long-visit-renewal" } };
    await store.putActiveCaptureState(active); store.close();
    store = await EncryptedIndexedDbFlowStore.open(options);
    try { expect(await store.getActiveCaptureState()).toEqual(active); }
    finally { store.close(); }
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
