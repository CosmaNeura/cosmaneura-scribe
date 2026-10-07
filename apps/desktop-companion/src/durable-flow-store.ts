import { assertActiveCaptureProgression, assertActiveCaptureState, assertPreparationProgression,
  assertPreparationState, assertReservationIntent, assertSessionDek, assertSessionKeyState } from "../../capture/src/flow/encrypted-store";
import { createWrappedSessionKey, type WrappedSessionKey } from "../../capture/src/flow/session-key";
import type { CaptureSessionKeyFactory } from "../../capture/src/flow/controller";
import type { ActiveCaptureState, CaptureFlowStore, CapturePreparationState, ReservationIntent,
  SessionKeyBindingState } from "../../capture/src/flow/types";
import { type DesktopRecordNamespace, type DesktopStoredRecord, conflict, failure, uuid } from "./durable-record-store.js";

type LocalKey = NonNullable<WrappedSessionKey["localKey"]>;
type Session = { readonly state: SessionKeyBindingState; readonly localKey: LocalKey };

/** Same capture state/progression contract as IndexedDB, with atomic encrypted
 * local-key/state commits. Only this store's key factory can supply candidates. */
export class DurableDesktopFlowStore implements CaptureFlowStore {
  private readonly candidates = new WeakMap<CryptoKey, { sessionId: string; value: WrappedSessionKey }>();
  constructor(private readonly records: DesktopRecordNamespace) {}

  readonly createSessionKey: CaptureSessionKeyFactory = async (sessionId, published, crypto) => {
    const value = await createWrappedSessionKey(published, crypto, this.records.wrapping(uuid(sessionId)));
    if (!value.localKey) throw failure();
    this.candidates.set(value.key, { sessionId: uuid(sessionId), value }); return value;
  };
  async putPreparationState(state: CapturePreparationState): Promise<void> {
    state = structuredClone(state);
    assertPreparationState(state);
    const prior = await this.read("preparation", assertPreparationState);
    if (prior) assertPreparationProgression(prior.value, state);
    await this.save("preparation", prior?.revision ?? null, state);
  }
  async getPreparationState(): Promise<CapturePreparationState | null> {
    return (await this.read("preparation", assertPreparationState))?.value ?? null;
  }
  async putActiveCaptureState(state: ActiveCaptureState): Promise<void> {
    state = structuredClone(state);
    assertActiveCaptureState(state);
    const prior = await this.read("active", assertActiveCaptureState);
    if (prior) {
      if (prior.value.sessionId !== state.sessionId) throw conflict();
      assertActiveCaptureProgression(prior.value, state);
    }
    await this.save("active", prior?.revision ?? null, state);
  }
  async getActiveCaptureState(): Promise<ActiveCaptureState | null> {
    return (await this.read("active", assertActiveCaptureState))?.value ?? null;
  }
  async clearCompletedCapture(sessionId: string): Promise<void> {
    uuid(sessionId);
    const prior = await this.read("active", assertActiveCaptureState);
    if (!prior) return;
    if (prior.value.sessionId !== sessionId) throw conflict();
    this.records.removeGroup("active", prior.revision, ["preparation", `session:${uuid(sessionId)}`]);
  }
  async putReservationIntent(intent: ReservationIntent): Promise<void> {
    intent = structuredClone(intent);
    assertReservationIntent(intent);
    const key = `intent:${intent.intentId}`, prior = await this.read(key, assertReservationIntent);
    if (prior) { if (JSON.stringify(prior.value) !== JSON.stringify(intent)) throw conflict(); return; }
    await this.save(key, null, intent);
  }
  async listReservationIntents(): Promise<readonly ReservationIntent[]> {
    const records = await this.records.list();
    try {
      return records.filter(record => record.key.startsWith("intent:")).map(record => decode(record, assertReservationIntent).value)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } finally { records.forEach(record => record.data.fill(0)); }
  }
  async deleteReservationIntent(intentId: string): Promise<void> {
    const key = `intent:${intentId}`, prior = await this.read(key, assertReservationIntent);
    if (prior) this.records.delete(key, prior.revision);
  }
  async putSessionKeyCandidate(state: SessionKeyBindingState, key: CryptoKey): Promise<void> {
    await this.saveCandidate(state, key, null);
  }
  async replacePendingSessionKeyCandidate(state: SessionKeyBindingState, key: CryptoKey): Promise<void> {
    state = structuredClone(state);
    const prior = await this.read(`session:${uuid(state.sessionId)}`, assertSession);
    if (prior?.value.state.state !== "pending") throw conflict();
    await this.saveCandidate(state, key, prior.revision);
  }
  async getSessionKeyState(sessionId: string): Promise<SessionKeyBindingState | null> {
    const value = (await this.read(`session:${uuid(sessionId)}`, assertSession))?.value.state ?? null;
    if (value && uuid(value.sessionId) !== uuid(sessionId)) throw failure();
    return value;
  }
  async getSessionKey(sessionId: string): Promise<CryptoKey | null> {
    const stored = await this.read(`session:${uuid(sessionId)}`, assertSession);
    if (!stored) return null;
    if (uuid(stored.value.state.sessionId) !== uuid(sessionId)) throw failure();
    const key = await this.records.unwrap(sessionId, stored.value.localKey); assertSessionDek(key); return key;
  }
  async retainPlaybackKey(sessionId: string, archive: DesktopRecordNamespace): Promise<void> {
    const stored = await this.read(`session:${uuid(sessionId)}`, assertSession);
    if (!stored || stored.value.state.sessionId !== sessionId || stored.value.state.state !== "bound") throw failure();
    const existing = await archive.get("session-key");
    if (existing) {
      try { if (JSON.stringify(decode(existing, assertSession).value) !== JSON.stringify(stored.value)) throw failure(); }
      finally { existing.data.fill(0); }
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(stored.value));
    try { await archive.save("session-key", null, bytes); } finally { bytes.fill(0); }
  }
  async playbackKey(sessionId: string, archive: DesktopRecordNamespace): Promise<CryptoKey | null> {
    const saved = await archive.get("session-key"); if (!saved) return null;
    try {
      const value = decode(saved, assertSession).value;
      if (value.state.sessionId !== sessionId || value.state.state !== "bound") throw failure();
      return await this.records.unwrapForPlayback(sessionId, value.localKey);
    } finally { saved.data.fill(0); }
  }
  async markSessionKeyBound(sessionId: string): Promise<void> {
    const key = `session:${uuid(sessionId)}`, prior = await this.read(key, assertSession);
    if (!prior || uuid(prior.value.state.sessionId) !== uuid(sessionId)) throw failure();
    if (prior.value.state.state === "bound") return;
    await this.save(key, prior.revision, { ...prior.value, state: { ...prior.value.state, state: "bound" } });
  }
  private async saveCandidate(state: SessionKeyBindingState, key: CryptoKey, revision: number | null): Promise<void> {
    assertSessionKeyState(state); assertSessionDek(key);
    const candidate = this.candidates.get(key);
    if (state.state !== "pending" || !candidate?.value.localKey || candidate.sessionId !== uuid(state.sessionId)
      || candidate.value.wrappedDek !== state.wrappedDek || candidate.value.keyVersion !== state.keyVersion) throw failure();
    await this.save(`session:${uuid(state.sessionId)}`, revision, { state, localKey: candidate.value.localKey });
    this.candidates.delete(key);
  }
  private async read<T>(key: string, validate: (value: unknown) => asserts value is T): Promise<{ value: T; revision: number } | null> {
    const record = await this.records.get(key);
    if (!record) return null;
    try { return decode(record, validate); }
    finally { record.data.fill(0); }
  }
  private async save(key: string, revision: number | null, value: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    try { await this.records.save(key, revision, bytes); }
    finally { bytes.fill(0); }
  }
}
function decode<T>(record: DesktopStoredRecord, validate: (value: unknown) => asserts value is T): { value: T; revision: number } {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.data));
    validate(value); return { value, revision: record.revision };
  } catch { throw failure(); }
}
function assertSession(value: unknown): asserts value is Session {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "localKey,state" || !("state" in value) || !("localKey" in value)) throw failure();
  assertSessionKeyState(value.state);
  const local = value.localKey;
  if (!local || typeof local !== "object" || Object.keys(local).sort().join(",") !== "ciphertext,nonce"
    || !("nonce" in local) || typeof local.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(local.nonce)
    || !("ciphertext" in local) || typeof local.ciphertext !== "string" || !/^[A-Za-z0-9_-]{64}$/u.test(local.ciphertext)) throw failure();
}
