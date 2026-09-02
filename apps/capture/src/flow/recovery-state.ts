import { MAX_CHUNKS } from "@cosmaneura-scribe/capture-protocol";

import { QueueInvariantError } from "../queue/errors";
import {
  CAPTURE_RECOVERY_SCHEMA_VERSION,
  type CaptureGapReasonCode,
  type CaptureGapV1,
  type CaptureRecoveryStateV1,
  type CaptureSegmentV1,
} from "./types";

export interface RecoverySegmentStart {
  readonly segmentId: string;
  readonly recoveryGapId: string;
  readonly startedAt: string;
  readonly leaseGeneration: number;
  readonly captureAuthorizedUntil: string;
}

export interface RecoveryGapObservation {
  readonly reasonCode: CaptureGapReasonCode;
  readonly observedAt: string;
  readonly nextSequenceNumber: number;
}

export interface RecoveryGapAcknowledgement {
  readonly acknowledgedAt: string;
  readonly idempotencyKey: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/u;

export function createCaptureRecoveryState(sessionId: string): CaptureRecoveryStateV1 {
  return {
    schemaVersion: CAPTURE_RECOVERY_SCHEMA_VERSION,
    sessionId,
    localRevision: 1,
    phase: "ready",
    nextSegmentOrdinal: 0,
    nextSequenceNumber: 0,
    currentSegmentId: null,
    segments: [],
    gaps: [],
    noteReadiness: "eligible",
  };
}

export function beginRecoverySegment(
  state: CaptureRecoveryStateV1,
  input: RecoverySegmentStart,
): CaptureRecoveryStateV1 {
  if (
    state.phase !== "ready" ||
    state.currentSegmentId !== null ||
    state.gaps.length !== 0 ||
    state.nextSequenceNumber >= MAX_CHUNKS
  ) {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
  const segment: CaptureSegmentV1 = {
    segmentId: input.segmentId,
    recoveryGapId: input.recoveryGapId,
    ordinal: state.nextSegmentOrdinal,
    firstSequenceNumber: state.nextSequenceNumber,
    lastSequenceNumber: null,
    state: "recording",
    startedAt: input.startedAt,
    endedAt: null,
    leaseGeneration: input.leaseGeneration,
    captureAuthorizedUntil: input.captureAuthorizedUntil,
  };
  return {
    ...state,
    localRevision: state.localRevision + 1,
    phase: "recording",
    nextSegmentOrdinal: state.nextSegmentOrdinal + 1,
    currentSegmentId: segment.segmentId,
    segments: [...state.segments, segment],
  };
}

export function observeRecoveryGap(
  state: CaptureRecoveryStateV1,
  input: RecoveryGapObservation,
): CaptureRecoveryStateV1 {
  const current = currentSegment(state);
  const existingGap = state.gaps.find((gap) => gap.gapId === current.recoveryGapId);
  if (existingGap !== undefined) return state;
  if (state.phase !== "recording" || current.state !== "recording") {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
  assertNextSequence(current, input.nextSequenceNumber);
  const lastSequenceNumber = lastSequence(current, input.nextSequenceNumber);
  const uncertain = input.reasonCode === "process_recovery_unknown" ||
    input.reasonCode === "capture_source_failed" ||
    input.reasonCode === "capture_source_stalled";
  const terminal: CaptureSegmentV1 = {
    ...current,
    state: uncertain ? "uncertain" : "interrupted",
    lastSequenceNumber,
    endedAt: input.observedAt,
  };
  const gap: CaptureGapV1 = {
    gapId: current.recoveryGapId,
    precedingSegmentId: current.segmentId,
    followingSegmentId: null,
    reasonCode: input.reasonCode,
    observedAt: input.observedAt,
    lastCommittedSequenceNumber: lastSequenceNumber,
    acknowledgement: null,
    reviewState: "required",
  };
  return {
    ...state,
    localRevision: state.localRevision + 1,
    phase: "interruption_closing",
    nextSequenceNumber: input.nextSequenceNumber,
    segments: replaceCurrentSegment(state, terminal),
    gaps: [...state.gaps, gap],
    noteReadiness: "review_required",
  };
}

export function confirmRecoverySourceClosed(
  state: CaptureRecoveryStateV1,
): CaptureRecoveryStateV1 {
  if (state.phase === "ack_required" || state.phase === "authority_required") return state;
  if (state.phase !== "interruption_closing" || state.currentSegmentId === null) {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
  return {
    ...state,
    localRevision: state.localRevision + 1,
    phase: "ack_required",
    currentSegmentId: null,
  };
}

export function acknowledgeRecoveryGap(
  state: CaptureRecoveryStateV1,
  input: RecoveryGapAcknowledgement,
): CaptureRecoveryStateV1 {
  const currentGap = state.gaps.at(-1);
  if (currentGap === undefined) {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
  if (currentGap.acknowledgement !== null) {
    if (
      currentGap.acknowledgement.idempotencyKey === input.idempotencyKey &&
      currentGap.acknowledgement.acknowledgedAt === input.acknowledgedAt
    ) return state;
    throw new QueueInvariantError("capture_gap_acknowledgement_conflict");
  }
  if (state.phase !== "ack_required") {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
  const acknowledged: CaptureGapV1 = {
    ...currentGap,
    acknowledgement: {
      decision: "continue_with_known_gap",
      acknowledgedAt: input.acknowledgedAt,
      idempotencyKey: input.idempotencyKey,
    },
  };
  return {
    ...state,
    localRevision: state.localRevision + 1,
    phase: "authority_required",
    gaps: [...state.gaps.slice(0, -1), acknowledged],
  };
}

export function stopRecoverySegment(
  state: CaptureRecoveryStateV1,
  endedAt: string,
  nextSequenceNumber: number,
): CaptureRecoveryStateV1 {
  const current = currentSegment(state);
  if (state.phase !== "recording" || current.state !== "recording") {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
  assertNextSequence(current, nextSequenceNumber);
  return {
    ...state,
    localRevision: state.localRevision + 1,
    phase: "stopped",
    nextSequenceNumber,
    currentSegmentId: null,
    segments: replaceCurrentSegment(state, {
      ...current,
      state: "stopped",
      lastSequenceNumber: lastSequence(current, nextSequenceNumber),
      endedAt,
    }),
  };
}

export function assertCaptureRecoveryState(
  value: unknown,
): asserts value is CaptureRecoveryStateV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CAPTURE_RECOVERY_SCHEMA_VERSION ||
    typeof value.sessionId !== "string" ||
    !Number.isSafeInteger(value.localRevision) ||
    (value.localRevision as number) < 1 ||
    !isRecoveryPhase(value.phase) ||
    !Number.isSafeInteger(value.nextSegmentOrdinal) ||
    (value.nextSegmentOrdinal as number) < 0 ||
    !isSequenceBoundary(value.nextSequenceNumber) ||
    (value.currentSegmentId !== null && typeof value.currentSegmentId !== "string") ||
    !Array.isArray(value.segments) ||
    !Array.isArray(value.gaps) ||
    (value.noteReadiness !== "eligible" && value.noteReadiness !== "review_required")
  ) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }
  assertExactKeys(value, [
    "schemaVersion",
    "sessionId",
    "localRevision",
    "phase",
    "nextSegmentOrdinal",
    "nextSequenceNumber",
    "currentSegmentId",
    "segments",
    "gaps",
    "noteReadiness",
  ]);
  assertUuid(value.sessionId);
  if (value.currentSegmentId !== null) assertUuid(value.currentSegmentId);
  const segments = value.segments as unknown[];
  const gaps = value.gaps as unknown[];
  if (
    segments.length > MAX_CHUNKS ||
    gaps.length > MAX_CHUNKS ||
    value.nextSegmentOrdinal !== segments.length ||
    (gaps.length === 0) !== (value.noteReadiness === "eligible")
  ) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }

  const segmentIds = new Set<string>();
  const recoveryGapIds = new Set<string>();
  let expectedFirstSequence = 0;
  for (const [ordinal, candidate] of segments.entries()) {
    assertCaptureSegment(candidate, ordinal, expectedFirstSequence);
    segmentIds.add(candidate.segmentId);
    recoveryGapIds.add(candidate.recoveryGapId);
    if (segmentIds.size !== ordinal + 1 || recoveryGapIds.size !== ordinal + 1) {
      throw new QueueInvariantError("invalid_capture_recovery_state");
    }
    expectedFirstSequence = candidate.lastSequenceNumber === null
      ? candidate.firstSequenceNumber
      : candidate.lastSequenceNumber + 1;
  }
  if (value.nextSequenceNumber !== expectedFirstSequence) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }

  const gapsBySegment = new Map<string, CaptureGapV1>();
  const gapIds = new Set<string>();
  let previousGapOrdinal = -1;
  for (const candidate of gaps) {
    assertCaptureGap(candidate);
    if (
      gapsBySegment.has(candidate.precedingSegmentId) ||
      gapIds.has(candidate.gapId) ||
      !segmentIds.has(candidate.precedingSegmentId) ||
      !recoveryGapIds.has(candidate.gapId)
    ) {
      throw new QueueInvariantError("invalid_capture_recovery_state");
    }
    gapIds.add(candidate.gapId);
    const segment = segments.find(
      (item): item is CaptureSegmentV1 =>
        isRecord(item) && item.segmentId === candidate.precedingSegmentId,
    );
    if (
      segment === undefined ||
      segment.recoveryGapId !== candidate.gapId ||
      segment.lastSequenceNumber !== candidate.lastCommittedSequenceNumber ||
      segment.endedAt !== candidate.observedAt ||
      segment.ordinal <= previousGapOrdinal ||
      (segment.state !== "interrupted" && segment.state !== "uncertain")
    ) {
      throw new QueueInvariantError("invalid_capture_recovery_state");
    }
    previousGapOrdinal = segment.ordinal;
    gapsBySegment.set(candidate.precedingSegmentId, candidate);
  }
  for (const candidate of segments) {
    const segment = candidate as CaptureSegmentV1;
    const hasGap = gapsBySegment.has(segment.segmentId);
    if (hasGap !== (segment.state === "interrupted" || segment.state === "uncertain")) {
      throw new QueueInvariantError("invalid_capture_recovery_state");
    }
  }
  assertRecoveryPhaseShape(value as unknown as CaptureRecoveryStateV1);
}

export function assertCaptureRecoveryProgression(
  existing: CaptureRecoveryStateV1,
  replacement: CaptureRecoveryStateV1,
): void {
  if (JSON.stringify(existing) === JSON.stringify(replacement)) return;
  if (
    existing.sessionId !== replacement.sessionId ||
    replacement.localRevision !== existing.localRevision + 1 ||
    replacement.nextSegmentOrdinal < existing.nextSegmentOrdinal ||
    replacement.nextSequenceNumber < existing.nextSequenceNumber ||
    (existing.noteReadiness === "review_required" &&
      replacement.noteReadiness !== "review_required") ||
    !isAllowedPhaseTransition(existing.phase, replacement.phase) ||
    !isSegmentProgression(existing.segments, replacement.segments) ||
    !isGapProgression(existing.gaps, replacement.gaps)
  ) {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
}

function currentSegment(state: CaptureRecoveryStateV1): CaptureSegmentV1 {
  if (state.currentSegmentId === null) {
    throw new QueueInvariantError("capture_recovery_state_conflict");
  }
  const current = state.segments.find((segment) => segment.segmentId === state.currentSegmentId);
  if (current === undefined) throw new QueueInvariantError("capture_recovery_state_conflict");
  return current;
}

function replaceCurrentSegment(
  state: CaptureRecoveryStateV1,
  replacement: CaptureSegmentV1,
): readonly CaptureSegmentV1[] {
  return state.segments.map((segment) =>
    segment.segmentId === replacement.segmentId ? replacement : segment);
}

function assertNextSequence(segment: CaptureSegmentV1, nextSequenceNumber: number): void {
  if (
    !Number.isSafeInteger(nextSequenceNumber) ||
    nextSequenceNumber < segment.firstSequenceNumber ||
    nextSequenceNumber > MAX_CHUNKS
  ) {
    throw new QueueInvariantError("capture_recovery_sequence_conflict");
  }
}

function lastSequence(
  segment: CaptureSegmentV1,
  nextSequenceNumber: number,
): number | null {
  return nextSequenceNumber === segment.firstSequenceNumber ? null : nextSequenceNumber - 1;
}

function assertCaptureSegment(
  value: unknown,
  ordinal: number,
  expectedFirstSequence: number,
): asserts value is CaptureSegmentV1 {
  if (
    !isRecord(value) ||
    typeof value.segmentId !== "string" ||
    typeof value.recoveryGapId !== "string" ||
    value.ordinal !== ordinal ||
    value.firstSequenceNumber !== expectedFirstSequence ||
    !isSequence(value.firstSequenceNumber) ||
    (value.lastSequenceNumber !== null && !isSequence(value.lastSequenceNumber)) ||
    !isSegmentState(value.state) ||
    typeof value.startedAt !== "string" ||
    (value.endedAt !== null && typeof value.endedAt !== "string") ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    typeof value.captureAuthorizedUntil !== "string"
  ) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }
  assertExactKeys(value, [
    "segmentId",
    "recoveryGapId",
    "ordinal",
    "firstSequenceNumber",
    "lastSequenceNumber",
    "state",
    "startedAt",
    "endedAt",
    "leaseGeneration",
    "captureAuthorizedUntil",
  ]);
  assertUuid(value.segmentId);
  assertUuid(value.recoveryGapId);
  assertDate(value.startedAt);
  assertDate(value.captureAuthorizedUntil);
  if (value.endedAt !== null) assertDate(value.endedAt);
  if (
    (value.state === "recording") !== (value.endedAt === null) ||
    (value.state === "recording" && value.lastSequenceNumber !== null) ||
    (value.endedAt !== null && Date.parse(value.endedAt) < Date.parse(value.startedAt)) ||
    (value.lastSequenceNumber !== null && value.lastSequenceNumber < value.firstSequenceNumber)
  ) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }
}

function assertCaptureGap(value: unknown): asserts value is CaptureGapV1 {
  if (
    !isRecord(value) ||
    typeof value.gapId !== "string" ||
    typeof value.precedingSegmentId !== "string" ||
    value.followingSegmentId !== null ||
    !isGapReason(value.reasonCode) ||
    typeof value.observedAt !== "string" ||
    (value.lastCommittedSequenceNumber !== null &&
      !isSequence(value.lastCommittedSequenceNumber)) ||
    (value.acknowledgement !== null && !isRecord(value.acknowledgement)) ||
    value.reviewState !== "required"
  ) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }
  assertExactKeys(value, [
    "gapId",
    "precedingSegmentId",
    "followingSegmentId",
    "reasonCode",
    "observedAt",
    "lastCommittedSequenceNumber",
    "acknowledgement",
    "reviewState",
  ]);
  assertUuid(value.gapId);
  assertUuid(value.precedingSegmentId);
  assertDate(value.observedAt);
  if (value.acknowledgement !== null) {
    assertExactKeys(value.acknowledgement, [
      "decision",
      "acknowledgedAt",
      "idempotencyKey",
    ]);
    if (
      value.acknowledgement.decision !== "continue_with_known_gap" ||
      typeof value.acknowledgement.acknowledgedAt !== "string" ||
      typeof value.acknowledgement.idempotencyKey !== "string" ||
      !IDEMPOTENCY_PATTERN.test(value.acknowledgement.idempotencyKey)
    ) {
      throw new QueueInvariantError("invalid_capture_recovery_state");
    }
    assertDate(value.acknowledgement.acknowledgedAt);
    if (Date.parse(value.acknowledgement.acknowledgedAt) < Date.parse(value.observedAt)) {
      throw new QueueInvariantError("invalid_capture_recovery_state");
    }
  }
}

function assertRecoveryPhaseShape(state: CaptureRecoveryStateV1): void {
  const current = state.currentSegmentId === null
    ? undefined
    : state.segments.find((segment) => segment.segmentId === state.currentSegmentId);
  const lastGap = state.gaps.at(-1);
  const valid =
    (state.phase === "ready" && current === undefined && state.segments.length === 0) ||
    (state.phase === "recording" && current?.state === "recording") ||
    (state.phase === "interruption_closing" &&
      current !== undefined &&
      (current.state === "interrupted" || current.state === "uncertain") &&
      lastGap?.precedingSegmentId === current.segmentId &&
      lastGap.acknowledgement === null) ||
    (state.phase === "ack_required" && current === undefined &&
      lastGap?.acknowledgement === null) ||
    (state.phase === "authority_required" && current === undefined &&
      lastGap?.acknowledgement !== null) ||
    (state.phase === "stopped" && current === undefined &&
      state.segments.at(-1)?.state === "stopped" && state.gaps.length === 0);
  if (!valid) throw new QueueInvariantError("invalid_capture_recovery_state");
}

function isAllowedPhaseTransition(
  existing: CaptureRecoveryStateV1["phase"],
  replacement: CaptureRecoveryStateV1["phase"],
): boolean {
  return (
    (existing === "ready" && replacement === "recording") ||
    (existing === "recording" &&
      (replacement === "interruption_closing" || replacement === "stopped")) ||
    (existing === "interruption_closing" && replacement === "ack_required") ||
    (existing === "ack_required" && replacement === "authority_required")
  );
}

function isSegmentProgression(
  existing: readonly CaptureSegmentV1[],
  replacement: readonly CaptureSegmentV1[],
): boolean {
  if (replacement.length < existing.length || replacement.length > existing.length + 1) return false;
  for (let index = 0; index < existing.length; index += 1) {
    const before = existing[index];
    const after = replacement[index];
    if (before === undefined || after === undefined) return false;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const isLast = index === existing.length - 1;
    if (
      !isLast ||
      before.state !== "recording" ||
      (after.state !== "stopped" && after.state !== "interrupted" && after.state !== "uncertain") ||
      before.segmentId !== after.segmentId ||
      before.recoveryGapId !== after.recoveryGapId ||
      before.ordinal !== after.ordinal ||
      before.firstSequenceNumber !== after.firstSequenceNumber ||
      before.startedAt !== after.startedAt ||
      before.leaseGeneration !== after.leaseGeneration ||
      before.captureAuthorizedUntil !== after.captureAuthorizedUntil
    ) return false;
  }
  return true;
}

function isGapProgression(
  existing: readonly CaptureGapV1[],
  replacement: readonly CaptureGapV1[],
): boolean {
  if (replacement.length < existing.length || replacement.length > existing.length + 1) return false;
  for (let index = 0; index < existing.length; index += 1) {
    const before = existing[index];
    const after = replacement[index];
    if (before === undefined || after === undefined) return false;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (
      index !== existing.length - 1 ||
      before.acknowledgement !== null ||
      after.acknowledgement === null ||
      before.gapId !== after.gapId ||
      before.precedingSegmentId !== after.precedingSegmentId ||
      before.followingSegmentId !== after.followingSegmentId ||
      before.reasonCode !== after.reasonCode ||
      before.observedAt !== after.observedAt ||
      before.lastCommittedSequenceNumber !== after.lastCommittedSequenceNumber ||
      before.reviewState !== after.reviewState
    ) return false;
  }
  return true;
}

function isRecoveryPhase(value: unknown): value is CaptureRecoveryStateV1["phase"] {
  return value === "ready" || value === "recording" ||
    value === "interruption_closing" || value === "ack_required" ||
    value === "authority_required" || value === "stopped";
}

function isSegmentState(value: unknown): value is CaptureSegmentV1["state"] {
  return value === "recording" || value === "stopped" ||
    value === "interrupted" || value === "uncertain";
}

function isGapReason(value: unknown): value is CaptureGapReasonCode {
  return value === "audio_context_suspended" || value === "audio_device_disconnected" ||
    value === "audio_route_changed" || value === "audio_session_interrupted" ||
    value === "capture_backgrounded" || value === "capture_source_stalled" ||
    value === "capture_source_failed" || value === "capture_authority_expired" ||
    value === "process_recovery_unknown";
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < MAX_CHUNKS;
}

function isSequenceBoundary(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CHUNKS;
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new QueueInvariantError("invalid_capture_recovery_state");
}

function assertDate(value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new QueueInvariantError("invalid_capture_recovery_state");
  }
}
