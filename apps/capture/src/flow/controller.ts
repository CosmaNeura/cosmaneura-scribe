import {
  base64UrlDecode,
  base64UrlEncode,
  encodeEnvelope,
  NONCE_BYTES,
  PROTOCOL_VERSION,
} from "@cosmaneura-scribe/capture-protocol";

import type {
  CaptureBff,
  CaptureCapabilities,
  CaptureLeaseReceipt,
  CaptureTranscriptionStatus,
  ChunkReservationBatchReceipt,
  ConsentCreate,
  Transcript,
} from "../bff/contracts";
import { BffResponseError } from "../bff/http-client";
import { AudioCaptureError } from "../audio/errors";
import type {
  CapturedWavChunk,
  CaptureSource,
  CaptureSourceErrorCode,
  CaptureSourceInterruptionCode,
} from "../capture";
import { QueueInvariantError } from "../queue/errors";
import type { CaptureQueue } from "../queue/capture-queue";
import type { CaptureQueueTransport, ChunkReservation } from "../queue/types";
import { createWrappedSessionKey } from "./session-key";
import {
  FLOW_RECORD_SCHEMA_VERSION,
  type ActiveCapturePhase,
  type ActiveCaptureState,
  type CaptureFlowState,
  type CaptureFlowStore,
  type CapturePreparationState,
  type ReservationIntent,
  type SessionKeyBindingState,
} from "./types";

export interface SyntheticEncounter {
  readonly appointmentId: string;
  readonly practitionerId: string;
  readonly patientId: string;
  readonly participantRegions: readonly string[];
}

export interface CaptureFlowSnapshot {
  readonly state: CaptureFlowState;
  readonly statusCode: string;
  readonly sessionId: string | null;
  readonly recordedChunks: number;
  readonly queuedChunks: number;
  readonly elapsedSeconds: number;
  readonly remainingBudgetSeconds: number | null;
  readonly remainingAuthoritySeconds: number | null;
  readonly transcriptionStatus: CaptureTranscriptionStatus | null;
  readonly transcript: Transcript | null;
}

export interface CaptureFlowControllerOptions {
  readonly bff: CaptureBff;
  readonly flowStore: CaptureFlowStore;
  readonly queue: CaptureQueue;
  readonly queueTransport: CaptureQueueTransport;
  readonly source: CaptureSource;
  readonly crypto?: Crypto;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
}

type SnapshotListener = (snapshot: CaptureFlowSnapshot) => void;

export class CaptureFlowController {
  readonly #bff: CaptureBff;
  readonly #flowStore: CaptureFlowStore;
  readonly #queue: CaptureQueue;
  readonly #queueTransport: CaptureQueueTransport;
  readonly #source: CaptureSource;
  readonly #crypto: Crypto;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelTimeout: (handle: unknown) => void;
  readonly #listeners = new Set<SnapshotListener>();
  readonly #reservations = new Map<number, ChunkReservation>();

  #capabilities: CaptureCapabilities | null = null;
  #activeState: ActiveCaptureState | null = null;
  #lease: CaptureLeaseReceipt | null = null;
  #sessionId: string | null = null;
  #recordedPlaintextBytes = 0;
  #sourcePausedBySignal = false;
  #sourcePausePersistence: Promise<void> | null = null;
  #sourceStarted = false;
  #recordingAbortController: AbortController | null = null;
  #chunkPersistence: Promise<void> = Promise.resolve();
  #authorityExpiryRequested = false;
  #authorityTimeout: unknown = null;
  #authorityExpiryTask: Promise<void> | null = null;
  #snapshot: CaptureFlowSnapshot = {
    state: "idle",
    statusCode: "synthetic_preview_idle",
    sessionId: null,
    recordedChunks: 0,
    queuedChunks: 0,
    elapsedSeconds: 0,
    remainingBudgetSeconds: null,
    remainingAuthoritySeconds: null,
    transcriptionStatus: null,
    transcript: null,
  };

  public constructor(options: CaptureFlowControllerOptions) {
    this.#bff = options.bff;
    this.#flowStore = options.flowStore;
    this.#queue = options.queue;
    this.#queueTransport = options.queueTransport;
    this.#source = options.source;
    this.#crypto = options.crypto ?? globalThis.crypto;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => this.#crypto.randomUUID());
    this.#scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs));
    this.#cancelTimeout = options.cancelTimeout ?? ((handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
    if (this.#crypto?.subtle === undefined) {
      throw new QueueInvariantError("webcrypto_unavailable");
    }
  }

  public get snapshot(): CaptureFlowSnapshot {
    return structuredClone(this.#snapshot);
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  public async restore(): Promise<boolean> {
    this.#requireState("idle");
    const active = await this.#flowStore.getActiveCaptureState();
    if (active === null) {
      const preparation = await this.#flowStore.getPreparationState();
      if (preparation === null) return false;
      this.#setSnapshot({ state: "preparing", statusCode: "synthetic_preview_restoring" });
      try {
        await this.#continuePreparation(preparation);
        return true;
      } catch (error) {
        this.#fail();
        throw error;
      }
    }
    this.#setSnapshot({ state: "preparing", statusCode: "synthetic_preview_restoring" });
    try {
      this.#activeState = active;
      this.#sessionId = active.sessionId;
      this.#lease = active.lease;
      const keyState = await this.#flowStore.getSessionKeyState(active.sessionId);
      if (keyState === null) throw new QueueInvariantError("session_key_missing");
      await this.#bindStoredSessionKey(keyState);
      this.#setCapabilities(await this.#bff.getCapabilities(active.sessionId));
      if (this.#canCreateOrRecoverReservations()) {
        await this.#recoverReservationIntents();
      }
      let records = (await this.#queue.list()).filter(
        (record) => record.reservation.sessionId === active.sessionId,
      );
      if (records.length === 0 && this.#canCreateOrRecoverReservations()) {
        await this.#reserveInitialWindow();
        records = (await this.#queue.list()).filter(
          (record) => record.reservation.sessionId === active.sessionId,
        );
      }
      for (const record of records) {
        this.#reservations.set(record.reservation.sequenceNumber, record.reservation);
      }
      const recorded = records.filter((record) => record.state !== "reserved");
      const conservativeBytes = recorded.reduce(
        (total, record) => total + ("byteLength" in record ? record.byteLength : 0),
        0,
      );
      this.#recordedPlaintextBytes = Math.max(
        active.recordedPlaintextBytes,
        conservativeBytes,
      );
      const recordedChunks = Math.max(active.recordedChunks, recorded.length);
      this.#activeState = {
        ...this.#requireActiveState(),
        recordedChunks,
        recordedPlaintextBytes: this.#recordedPlaintextBytes,
      };
      await this.#flowStore.putActiveCaptureState(this.#activeState);
      const capturePhase =
        active.phase === "ready" || active.phase === "recording" || active.phase === "paused";
      const authorityExpired = capturePhase && !this.#hasActiveCaptureAuthority();
      if (active.phase === "recording" || authorityExpired) {
        await this.#saveActivePhase("paused");
      }
      const phase = this.#requireActiveState().phase;
      this.#setSnapshot({
        state: restoredSnapshotState(phase),
        statusCode: authorityExpired ? "capture_authority_expired" : restoredStatusCode(phase),
        sessionId: active.sessionId,
        recordedChunks,
        queuedChunks: records.length,
        elapsedSeconds: captureSeconds(this.#requireCapabilities(), recordedChunks),
        remainingBudgetSeconds: this.#remainingAggregateBudgetSeconds(recordedChunks),
        remainingAuthoritySeconds: this.#remainingCaptureSeconds(recordedChunks),
      });
      if (phase === "ready" && !authorityExpired) this.#armAuthorityDeadline();
      return true;
    } catch (error) {
      this.#fail();
      throw error;
    }
  }

  public async prepare(encounter: SyntheticEncounter): Promise<void> {
    this.#requireState("idle");
    this.#setSnapshot({ state: "preparing", statusCode: "synthetic_preview_preparing" });
    try {
      const startedAt = this.#now();
      const preparation: CapturePreparationState = {
        schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
        startedAt: startedAt.toISOString(),
        consentIdempotencyKey: this.#operationKey("consent"),
        completeIdempotencyKey: this.#operationKey("complete"),
        consentRequest: consentRequest(encounter, startedAt),
        consentId: null,
        sessionIdempotencyKey: null,
        sessionRequest: null,
        sessionId: null,
        leaseIdempotencyKey: null,
        leaseRequest: null,
      };
      await this.#flowStore.putPreparationState(preparation);
      await this.#continuePreparation(preparation);
    } catch (error) {
      this.#fail();
      throw error;
    }
  }

  async #continuePreparation(initial: CapturePreparationState): Promise<void> {
    let preparation = initial;
    const consent = await this.#bff.createConsent(preparation.consentRequest, {
      idempotencyKey: preparation.consentIdempotencyKey,
    });
    if (preparation.consentId !== null && preparation.consentId !== consent.id) {
      throw new QueueInvariantError("consent_receipt_conflict");
    }
    if (preparation.consentId === null) {
      preparation = { ...preparation, consentId: consent.id };
      await this.#flowStore.putPreparationState(preparation);
    }

    if (preparation.sessionRequest === null || preparation.sessionIdempotencyKey === null) {
      preparation = {
        ...preparation,
        sessionIdempotencyKey: this.#operationKey("session"),
        sessionRequest: {
          appointment_id: preparation.consentRequest.appointment_id,
          practitioner_id: preparation.consentRequest.practitioner_id,
          patient_id: preparation.consentRequest.patient_id,
          consent_record_id: consent.id,
          modality: "in_person",
        },
      };
      await this.#flowStore.putPreparationState(preparation);
    }
    const sessionRequest = preparation.sessionRequest;
    const sessionIdempotencyKey = preparation.sessionIdempotencyKey;
    if (sessionRequest === null || sessionIdempotencyKey === null) {
      throw new QueueInvariantError("preparation_state_incomplete");
    }
    const session = await this.#bff.createSession(sessionRequest, {
      idempotencyKey: sessionIdempotencyKey,
    });
    if (preparation.sessionId !== null && preparation.sessionId !== session.id) {
      throw new QueueInvariantError("session_receipt_conflict");
    }
    if (preparation.sessionId === null) {
      preparation = { ...preparation, sessionId: session.id };
      await this.#flowStore.putPreparationState(preparation);
    }
    this.#sessionId = session.id;
    this.#setSnapshot({ sessionId: session.id });

    await this.#bindSessionKey(session.id);
    this.#setCapabilities(await this.#bff.getCapabilities(session.id));
    if (preparation.leaseRequest === null || preparation.leaseIdempotencyKey === null) {
      preparation = {
        ...preparation,
        leaseIdempotencyKey: this.#operationKey("lease"),
        leaseRequest: { protocol_version: PROTOCOL_VERSION },
      };
      await this.#flowStore.putPreparationState(preparation);
    }
    const leaseRequest = preparation.leaseRequest;
    const leaseIdempotencyKey = preparation.leaseIdempotencyKey;
    if (leaseRequest === null || leaseIdempotencyKey === null) {
      throw new QueueInvariantError("preparation_state_incomplete");
    }
    this.#lease = await this.#bff.issueLease(
      session.id,
      leaseRequest,
      { idempotencyKey: leaseIdempotencyKey },
    );
    if (Date.parse(this.#lease.expires_at) <= this.#now().getTime()) {
      throw new QueueInvariantError("capture_lease_expired");
    }
    this.#activeState = {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      sessionId: session.id,
      lease: this.#lease,
      captureAuthorizedUntil: null,
      aggregatePlaintextBudgetBytes:
        this.#requireCapabilities().remaining_aggregate_plaintext_bytes,
      phase: "ready",
      completeIdempotencyKey: preparation.completeIdempotencyKey,
      recordedChunks: 0,
      recordedPlaintextBytes: 0,
      startedAt: preparation.startedAt,
    };
    await this.#flowStore.putActiveCaptureState(this.#activeState);
    await this.#recoverReservationIntents();
    if (this.#reservations.size === 0) await this.#reserveInitialWindow();
    if (!this.#hasActiveCaptureAuthority()) {
      await this.#pauseForExpiredAuthority();
      throw new QueueInvariantError("capture_authority_expired");
    }
    this.#setSnapshot({
      state: "ready",
      statusCode: "synthetic_preview_ready",
      remainingBudgetSeconds: this.#remainingAggregateBudgetSeconds(0),
      remainingAuthoritySeconds: this.#remainingCaptureSeconds(0),
    });
    this.#armAuthorityDeadline();
  }

  public async startRecording(): Promise<void> {
    this.#requireState("ready");
    if (!this.#hasActiveCaptureAuthority()) {
      await this.#pauseForExpiredAuthority();
      throw new QueueInvariantError("capture_authority_expired");
    }
    this.#clearAuthorityTimeout();
    const capabilities = this.#captureCapabilitiesForReservedWindow();
    this.#sourcePausedBySignal = false;
    this.#sourcePausePersistence = null;
    this.#sourceStarted = false;
    this.#authorityExpiryRequested = false;
    this.#recordingAbortController = new AbortController();
    await this.#saveActivePhase("recording");
    if (this.#authorityExpiryRequested || !this.#hasActiveCaptureAuthority()) {
      await this.#authorityExpiryTask;
      this.#authorityExpiryRequested = true;
      this.#recordingAbortController = null;
      if (this.#snapshot.state !== "paused") await this.#pauseForExpiredAuthority();
      throw new QueueInvariantError("capture_authority_expired");
    }
    this.#setSnapshot({ state: "recording", statusCode: "synthetic_preview_recording" });
    this.#armAuthorityDeadline();
    try {
      await this.#source.start({
        capabilities,
        onChunk: async (chunk) => this.#acceptChunk(chunk),
        onInterruption: (code) => this.#pauseAfterSourceSignal(code),
        onError: (code) => this.#pauseAfterSourceSignal(code),
        signal: this.#recordingAbortController.signal,
      });
      this.#sourceStarted = true;
      if (this.#recordingAbortController.signal.aborted) {
        await this.#source.stop();
        this.#sourceStarted = false;
      }
    } catch (error) {
      this.#clearAuthorityTimeout();
      this.#sourceStarted = false;
      if (!this.#sourcePausedBySignal) this.#fail();
      throw error;
    }
  }

  public async stopRecording(): Promise<void> {
    if (this.#snapshot.state !== "recording" && this.#snapshot.state !== "paused") {
      throw new QueueInvariantError("capture_state_conflict");
    }
    try {
      this.#clearAuthorityTimeout();
      await this.#authorityExpiryTask;
      try {
        await this.#source.stop();
      } catch (error) {
        if (
          !this.#sourcePausedBySignal ||
          isNativeStopFailure(error)
        ) throw error;
      }
      this.#sourceStarted = false;
      this.#recordingAbortController = null;
      await this.#sourcePausePersistence;
      if (this.#snapshot.recordedChunks < 1) {
        throw new QueueInvariantError("capture_has_no_chunks");
      }
      await this.#saveActivePhase("uploading");
      this.#setSnapshot({ state: "uploading", statusCode: "synthetic_preview_uploading" });
      await this.#drainAndComplete();
    } catch (error) {
      if (isNativeStopFailure(error)) {
        await this.#sourcePausePersistence;
        this.#setSnapshot({ state: "paused", statusCode: error.code });
      } else {
        this.#fail();
      }
      throw error;
    }
  }

  public async resumePendingWork(): Promise<void> {
    const active = this.#requireActiveState();
    try {
      if (active.phase === "uploading") {
        this.#setSnapshot({ state: "uploading", statusCode: "synthetic_preview_uploading" });
        await this.#drainAndComplete();
        return;
      }
      if (active.phase === "completing") {
        await this.#completeAndRefresh();
        return;
      }
      if (active.phase === "processing") {
        await this.refreshTranscriptionStatus();
        return;
      }
      throw new QueueInvariantError("capture_state_conflict");
    } catch (error) {
      this.#fail();
      throw error;
    }
  }

  public async refreshTranscriptionStatus(): Promise<void> {
    const sessionId = this.#requireSessionId();
    const status = await this.#bff.getTranscriptionStatus(sessionId);
    this.#setSnapshot({ transcriptionStatus: status });
    if (status.status === "completed" && status.transcript_available) {
      const transcript = await this.#bff.getTranscript(sessionId);
      this.#setSnapshot({
        state: "complete",
        statusCode: "synthetic_preview_complete",
        transcript,
      });
      await this.#flowStore.clearCompletedCapture(sessionId);
      this.#activeState = null;
    }
  }

  async #drainAndComplete(): Promise<void> {
    const drained = await this.#queue.drainOnce(this.#queueTransport);
    if (drained.items.some((item) => item.outcome !== "registered")) {
      throw new QueueInvariantError("capture_queue_not_drained");
    }
    for (const record of await this.#queue.list()) {
      if (
        record.reservation.sessionId === this.#requireSessionId() &&
        record.state === "registered"
      ) {
        await this.#queue.purge(record.reservation.objectId);
      }
    }
    await this.#saveActivePhase("completing");
    await this.#completeAndRefresh();
  }

  async #completeAndRefresh(): Promise<void> {
    const sessionId = this.#requireSessionId();
    const lease = this.#requireLease();
    const active = this.#requireActiveState();
    await this.#bff.completeCapture(sessionId, {
      protocol_version: PROTOCOL_VERSION,
      capture_lease_id: lease.lease_id,
      capture_lease_generation: lease.generation,
      channels: [{
        channel: "microphone",
        final_sequence_number: active.recordedChunks - 1,
      }],
    }, { idempotencyKey: active.completeIdempotencyKey });
    await this.#saveActivePhase("processing");
    this.#setSnapshot({ state: "processing", statusCode: "synthetic_preview_processing" });
    await this.refreshTranscriptionStatus();
  }

  async #bindSessionKey(sessionId: string): Promise<void> {
    const existing = await this.#flowStore.getSessionKeyState(sessionId);
    if (existing !== null) {
      await this.#bindStoredSessionKey(existing);
      return;
    }

    const first = await this.#createSessionKeyCandidate(sessionId);
    await this.#flowStore.putSessionKeyCandidate(first.state, first.key);
    try {
      await this.#bindStoredSessionKey(first.state);
    } catch (error) {
      if (!(error instanceof BffResponseError) || error.status !== 409) throw error;
      const replacement = await this.#createSessionKeyCandidate(sessionId);
      await this.#flowStore.replacePendingSessionKeyCandidate(replacement.state, replacement.key);
      await this.#bindStoredSessionKey(replacement.state);
    }
  }

  async #createSessionKeyCandidate(sessionId: string): Promise<{
    readonly state: SessionKeyBindingState;
    readonly key: CryptoKey;
  }> {
    const published = await this.#bff.getAudioEncryptionKey();
    const wrapped = await createWrappedSessionKey(published, this.#crypto);
    return {
      key: wrapped.key,
      state: {
        schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
        sessionId,
        keyVersion: wrapped.keyVersion,
        wrappedDek: wrapped.wrappedDek,
        idempotencyKey: this.#operationKey("bind-key"),
        state: "pending",
      },
    };
  }

  async #bindStoredSessionKey(state: SessionKeyBindingState): Promise<void> {
    if (state.state === "bound") return;
    await this.#bff.bindSessionAudioKey(state.sessionId, {
      key_version: state.keyVersion,
      wrapped_dek: state.wrappedDek,
    }, { idempotencyKey: state.idempotencyKey });
    await this.#flowStore.markSessionKeyBound(state.sessionId);
  }

  async #reserveInitialWindow(): Promise<void> {
    const capabilities = this.#requireCapabilities();
    const lease = this.#requireLease();
    const sessionId = this.#requireSessionId();
    const budgetCount = Math.floor(
      capabilities.remaining_aggregate_plaintext_bytes / capabilities.max_envelope_bytes,
    );
    const count = Math.min(
      capabilities.max_reservations_per_batch,
      capabilities.max_chunks,
      budgetCount,
    );
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new QueueInvariantError("capture_budget_exhausted");
    }
    const intent: ReservationIntent = {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      intentId: `${sessionId}:microphone:0:${String(count)}`,
      sessionId,
      idempotencyKey: this.#operationKey("reserve"),
      createdAt: this.#now().toISOString(),
      request: {
        protocol_version: PROTOCOL_VERSION,
        capture_lease_id: lease.lease_id,
        capture_lease_generation: lease.generation,
        channel: "microphone",
        first_sequence_number: 0,
        count,
      },
    };
    await this.#flowStore.putReservationIntent(intent);
    await this.#replayReservationIntent(intent);
  }

  async #recoverReservationIntents(): Promise<void> {
    for (const intent of await this.#flowStore.listReservationIntents()) {
      if (intent.sessionId !== this.#requireSessionId()) continue;
      await this.#replayReservationIntent(intent);
    }
  }

  async #replayReservationIntent(intent: ReservationIntent): Promise<void> {
    const batch = await this.#bff.reserveChunks(
      intent.sessionId,
      intent.request,
      { idempotencyKey: intent.idempotencyKey },
    );
    await this.#persistReservations(batch, intent.idempotencyKey);
    await this.#flowStore.deleteReservationIntent(intent.intentId);
  }

  async #persistReservations(
    batch: ChunkReservationBatchReceipt,
    idempotencyKey: string,
  ): Promise<void> {
    if (
      batch.protocol_version !== PROTOCOL_VERSION ||
      batch.session_id !== this.#requireSessionId() ||
      Number.isNaN(Date.parse(batch.capture_authorized_until))
    ) {
      throw new QueueInvariantError("invalid_capture_authority");
    }
    const active = this.#requireActiveState();
    if (
      active.captureAuthorizedUntil !== null &&
      active.captureAuthorizedUntil !== batch.capture_authorized_until
    ) {
      throw new QueueInvariantError("capture_authority_conflict");
    }
    if (active.captureAuthorizedUntil === null) {
      this.#activeState = {
        ...active,
        captureAuthorizedUntil: batch.capture_authorized_until,
      };
      await this.#flowStore.putActiveCaptureState(this.#activeState);
    }
    for (const remote of batch.reservations) {
      const reservation: ChunkReservation = {
        protocolVersion: remote.protocol_version,
        objectId: remote.object_id,
        sessionId: remote.session_id,
        channel: remote.channel,
        sequenceNumber: remote.sequence_number,
        additionalAuthenticatedData: remote.additional_authenticated_data,
        createdAt: remote.created_at,
      };
      await this.#queue.reserve(reservation, idempotencyKey);
      this.#reservations.set(reservation.sequenceNumber, reservation);
    }
    this.#setSnapshot({ queuedChunks: this.#reservations.size });
  }

  async #acceptChunk(chunk: CapturedWavChunk): Promise<void> {
    const task = this.#chunkPersistence.then(async () => {
      try {
        if (this.#authorityExpiryRequested) {
          throw new QueueInvariantError("capture_authority_expired");
        }
        await this.#acceptChunkAndPersist(chunk);
      } finally {
        chunk.wavBytes.fill(0);
      }
    });
    this.#chunkPersistence = task.catch(() => undefined);
    return task;
  }

  async #acceptChunkAndPersist(chunk: CapturedWavChunk): Promise<void> {
    if (this.#snapshot.state !== "recording") {
      throw new QueueInvariantError("capture_state_conflict");
    }
    if (!this.#hasActiveCaptureAuthority()) {
      await this.#pauseForExpiredAuthority();
      throw new QueueInvariantError("capture_authority_expired");
    }
    const reservation = this.#reservations.get(chunk.sequenceNumber);
    if (reservation === undefined) throw new QueueInvariantError("chunk_not_reserved");
    const capabilities = this.#requireCapabilities();
    if (chunk.durationMs > capabilities.target_chunk_duration_ms) {
      throw new QueueInvariantError("capture_chunk_duration_exceeded");
    }
    const nextPlaintextBytes = this.#recordedPlaintextBytes + chunk.wavBytes.byteLength;
    if (nextPlaintextBytes > this.#requireActiveState().aggregatePlaintextBudgetBytes) {
      throw new QueueInvariantError("capture_budget_exhausted");
    }
    const key = await this.#flowStore.getSessionKey(this.#requireSessionId());
    if (key === null) throw new QueueInvariantError("session_key_missing");
    const nonce = this.#crypto.getRandomValues(new Uint8Array(new ArrayBuffer(NONCE_BYTES)));
    const decodedAdditionalData = base64UrlDecode(reservation.additionalAuthenticatedData);
    const additionalData = new Uint8Array(new ArrayBuffer(decodedAdditionalData.byteLength));
    additionalData.set(decodedAdditionalData);
    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await this.#crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData },
        key,
        chunk.wavBytes,
      );
    } finally {
      chunk.wavBytes.fill(0);
    }
    const ciphertextBytes = new Uint8Array(ciphertext);
    let envelope: Uint8Array;
    try {
      envelope = encodeEnvelope({
        schema_version: PROTOCOL_VERSION,
        content_encryption: "A256GCM",
        nonce: base64UrlEncode(nonce),
        media_type: "audio/wav",
      }, ciphertextBytes);
    } finally {
      ciphertextBytes.fill(0);
    }
    if (envelope.byteLength > capabilities.max_envelope_bytes) {
      envelope.fill(0);
      throw new QueueInvariantError("capture_envelope_too_large");
    }
    await this.#queue.encrypt(reservation.objectId, envelope);
    envelope.fill(0);
    this.#recordedPlaintextBytes = nextPlaintextBytes;
    const recordedChunks = this.#snapshot.recordedChunks + 1;
    const active = this.#requireActiveState();
    this.#activeState = {
      ...active,
      recordedChunks,
      recordedPlaintextBytes: this.#recordedPlaintextBytes,
    };
    await this.#flowStore.putActiveCaptureState(this.#activeState);
    this.#setSnapshot({
      recordedChunks,
      elapsedSeconds: captureSeconds(capabilities, recordedChunks),
      remainingBudgetSeconds: this.#remainingAggregateBudgetSeconds(recordedChunks),
      remainingAuthoritySeconds: this.#remainingCaptureSeconds(recordedChunks),
    });
  }

  #setCapabilities(capabilities: CaptureCapabilities): void {
    this.#queue.configureUploadConcurrency(capabilities.upload_concurrency);
    this.#capabilities = capabilities;
  }

  #canCreateOrRecoverReservations(): boolean {
    const active = this.#requireActiveState();
    if (Date.parse(active.lease.expires_at) <= this.#now().getTime()) return false;
    return (
      active.captureAuthorizedUntil === null ||
      Date.parse(active.captureAuthorizedUntil) > this.#now().getTime()
    );
  }

  #hasActiveCaptureAuthority(): boolean {
    const deadline = this.#captureAuthorityDeadline();
    return deadline !== null && deadline > this.#now().getTime() && this.#reservations.size > 0;
  }

  #captureAuthorityDeadline(): number | null {
    const active = this.#requireActiveState();
    if (active.captureAuthorizedUntil === null) return null;
    return Math.min(
      Date.parse(active.lease.expires_at),
      Date.parse(active.captureAuthorizedUntil),
    );
  }

  #captureCapabilitiesForReservedWindow(): CaptureCapabilities {
    const capabilities = this.#requireCapabilities();
    const deadline = this.#captureAuthorityDeadline();
    if (deadline === null) throw new QueueInvariantError("capture_authority_missing");
    const windowChunks = Math.floor(
      Math.max(0, deadline - this.#now().getTime()) /
        capabilities.target_chunk_duration_ms,
    );
    const aggregateRemainingBytes = Math.max(
      0,
      this.#requireActiveState().aggregatePlaintextBudgetBytes - this.#recordedPlaintextBytes,
    );
    const budgetChunks = Math.floor(aggregateRemainingBytes / capabilities.max_envelope_bytes);
    const maxChunks = Math.min(
      capabilities.max_chunks,
      this.#reservations.size,
      windowChunks,
      budgetChunks,
    );
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) {
      throw new QueueInvariantError("capture_authority_expired");
    }
    return {
      ...capabilities,
      max_chunks: maxChunks,
      remaining_aggregate_plaintext_bytes: Math.min(
        aggregateRemainingBytes,
        maxChunks * capabilities.max_envelope_bytes,
      ),
    };
  }

  #remainingCaptureSeconds(recordedChunks: number): number {
    const capabilities = this.#requireCapabilities();
    const deadline = this.#captureAuthorityDeadline();
    if (deadline === null) return 0;
    const remainingReservedChunks = Math.max(0, this.#reservations.size - recordedChunks);
    const reservedSeconds = Math.floor(
      (remainingReservedChunks * capabilities.target_chunk_duration_ms) / 1_000,
    );
    const authoritySeconds = Math.max(
      0,
      Math.floor((deadline - this.#now().getTime()) / 1_000),
    );
    return Math.min(reservedSeconds, authoritySeconds);
  }

  #remainingAggregateBudgetSeconds(recordedChunks: number): number {
    const capabilities = this.#requireCapabilities();
    const budgetChunks = Math.min(
      capabilities.max_chunks,
      Math.floor(
        this.#requireActiveState().aggregatePlaintextBudgetBytes /
          capabilities.max_envelope_bytes,
      ),
    );
    return Math.max(
      0,
      Math.floor(
        ((budgetChunks - recordedChunks) * capabilities.target_chunk_duration_ms) / 1_000,
      ),
    );
  }

  async #pauseForExpiredAuthority(): Promise<void> {
    await this.#saveActivePhase("paused");
    this.#setSnapshot({
      state: "paused",
      statusCode: "capture_authority_expired",
      remainingAuthoritySeconds: 0,
    });
  }

  #armAuthorityDeadline(): void {
    this.#clearAuthorityTimeout();
    const deadline = this.#captureAuthorityDeadline();
    if (deadline === null) return;
    const delayMs = Math.max(0, deadline - this.#now().getTime());
    this.#authorityTimeout = this.#scheduleTimeout(() => {
      this.#authorityTimeout = null;
      this.#authorityExpiryRequested = true;
      const task = this.#expireCaptureAuthority();
      this.#authorityExpiryTask = task;
      void task
        .catch(() => this.#fail())
        .finally(() => {
          if (this.#authorityExpiryTask === task) this.#authorityExpiryTask = null;
        });
    }, delayMs);
  }

  #clearAuthorityTimeout(): void {
    if (this.#authorityTimeout === null) return;
    this.#cancelTimeout(this.#authorityTimeout);
    this.#authorityTimeout = null;
  }

  async #expireCaptureAuthority(): Promise<void> {
    if (this.#snapshot.state !== "ready" && this.#snapshot.state !== "recording") return;
    const wasRecording = this.#snapshot.state === "recording";
    if (wasRecording) {
      this.#sourcePausedBySignal = true;
      this.#recordingAbortController?.abort();
      await this.#chunkPersistence;
    }
    await this.#pauseForExpiredAuthority();
    if (wasRecording && this.#sourceStarted) {
      await this.#source.stop();
      this.#sourceStarted = false;
    }
  }

  #pauseAfterSourceSignal(
    code: CaptureSourceErrorCode | CaptureSourceInterruptionCode,
  ): void {
    if (this.#snapshot.state !== "recording" || this.#authorityExpiryRequested) return;
    this.#clearAuthorityTimeout();
    this.#sourcePausedBySignal = true;
    this.#setSnapshot({ state: "paused", statusCode: code });
    const persistence = this.#saveActivePhase("paused");
    this.#sourcePausePersistence = persistence;
    void persistence.catch(() => this.#fail());
  }

  #operationKey(operation: string): string {
    return `${operation}:${this.#idFactory()}`;
  }

  #requireState(expected: CaptureFlowState): void {
    if (this.#snapshot.state !== expected) throw new QueueInvariantError("capture_state_conflict");
  }

  #requireCapabilities(): CaptureCapabilities {
    if (this.#capabilities === null) throw new QueueInvariantError("capture_capabilities_missing");
    return this.#capabilities;
  }

  #requireLease(): CaptureLeaseReceipt {
    if (this.#lease === null) throw new QueueInvariantError("capture_lease_missing");
    return this.#lease;
  }

  #requireSessionId(): string {
    if (this.#sessionId === null) throw new QueueInvariantError("capture_session_missing");
    return this.#sessionId;
  }

  #requireActiveState(): ActiveCaptureState {
    if (this.#activeState === null) throw new QueueInvariantError("active_capture_missing");
    return this.#activeState;
  }

  async #saveActivePhase(phase: ActiveCapturePhase): Promise<void> {
    this.#activeState = { ...this.#requireActiveState(), phase };
    await this.#flowStore.putActiveCaptureState(this.#activeState);
  }

  #fail(): void {
    this.#clearAuthorityTimeout();
    this.#authorityExpiryRequested = true;
    this.#recordingAbortController?.abort();
    this.#setSnapshot({ state: "error", statusCode: "synthetic_preview_failed" });
  }

  #setSnapshot(patch: Partial<CaptureFlowSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener(this.snapshot);
  }
}

function isNativeStopFailure(error: unknown): error is AudioCaptureError {
  return error instanceof AudioCaptureError && error.code === "audio_capture_native_stop_failed";
}

function restoredSnapshotState(phase: ActiveCapturePhase): CaptureFlowState {
  if (phase === "ready") return "ready";
  if (phase === "recording" || phase === "paused") return "paused";
  if (phase === "uploading" || phase === "completing") return "uploading";
  return "processing";
}

function consentRequest(encounter: SyntheticEncounter, grantedAt: Date): ConsentCreate {
  return {
    appointment_id: encounter.appointmentId,
    practitioner_id: encounter.practitionerId,
    patient_id: encounter.patientId,
    modality: "in_person",
    method: "verbal_attestation",
    all_parties_consented: true,
    participant_regions: [...encounter.participantRegions],
    granted_at: grantedAt.toISOString(),
    evidence_object_id: null,
  };
}

function restoredStatusCode(phase: ActiveCapturePhase): string {
  if (phase === "ready") return "synthetic_preview_ready";
  if (phase === "recording" || phase === "paused") return "capture_recovered_paused";
  if (phase === "uploading" || phase === "completing") return "capture_recovered_uploading";
  return "capture_recovered_processing";
}

function captureSeconds(capabilities: CaptureCapabilities, recordedChunks: number): number {
  return Math.floor((recordedChunks * capabilities.target_chunk_duration_ms) / 1_000);
}
