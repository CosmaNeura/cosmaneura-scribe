import { describe, expect, it } from "vitest";

import {
  acknowledgeRecoveryGap,
  assertCaptureRecoveryProgression,
  assertCaptureRecoveryState,
  beginRecoverySegment,
  confirmRecoverySourceClosed,
  createCaptureRecoveryState,
  observeRecoveryGap,
  stopRecoverySegment,
} from "./recovery-state";
import type { CaptureRecoveryStateV1 } from "./types";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-4222-8222-222222222222";
const GAP_ID = "33333333-3333-4333-8333-333333333333";
const STARTED_AT = "2026-09-02T12:00:00.000Z";
const OBSERVED_AT = "2026-09-02T12:01:00.000Z";

describe("CaptureRecoveryStateV1", () => {
  it("preallocates a stable gap, preserves first terminal reason, and blocks readiness", () => {
    const recording = recordingState();
    const interrupted = observeRecoveryGap(recording, {
      reasonCode: "capture_backgrounded",
      observedAt: OBSERVED_AT,
      nextSequenceNumber: 2,
    });
    const replay = observeRecoveryGap(interrupted, {
      reasonCode: "capture_source_failed",
      observedAt: "2026-09-02T12:02:00.000Z",
      nextSequenceNumber: 3,
    });

    expect(replay).toBe(interrupted);
    expect(interrupted).toMatchObject({
      localRevision: 3,
      phase: "interruption_closing",
      nextSequenceNumber: 2,
      noteReadiness: "review_required",
      gaps: [{
        gapId: GAP_ID,
        reasonCode: "capture_backgrounded",
        lastCommittedSequenceNumber: 1,
      }],
    });
    expect(() => stopRecoverySegment(interrupted, OBSERVED_AT, 2)).toThrow(
      "capture_recovery_state_conflict",
    );
    expect(() => assertCaptureRecoveryState(interrupted)).not.toThrow();
  });

  it("makes continue_with_known_gap immutable and replay-safe", () => {
    const closing = observeRecoveryGap(recordingState(), {
      reasonCode: "capture_source_failed",
      observedAt: OBSERVED_AT,
      nextSequenceNumber: 1,
    });
    const closed = confirmRecoverySourceClosed(closing);
    const input = {
      acknowledgedAt: "2026-09-02T12:03:00.000Z",
      idempotencyKey: "ack-gap:44444444-4444-4444-8444-444444444444",
    };
    const acknowledged = acknowledgeRecoveryGap(closed, input);

    expect(acknowledgeRecoveryGap(acknowledged, input)).toBe(acknowledged);
    expect(acknowledged).toMatchObject({
      phase: "authority_required",
      noteReadiness: "review_required",
      gaps: [{ acknowledgement: { decision: "continue_with_known_gap" } }],
    });
    expect(() => acknowledgeRecoveryGap(acknowledged, {
      ...input,
      idempotencyKey: "ack-gap:55555555-5555-4555-8555-555555555555",
    })).toThrow("capture_gap_acknowledgement_conflict");
    expect(() => assertCaptureRecoveryProgression(closed, acknowledged)).not.toThrow();
  });

  it("accepts a clean ordered stop", () => {
    const stopped = stopRecoverySegment(recordingState(), OBSERVED_AT, 2);
    expect(stopped).toMatchObject({
      phase: "stopped",
      nextSequenceNumber: 2,
      noteReadiness: "eligible",
      segments: [{ state: "stopped", lastSequenceNumber: 1 }],
    });
    expect(() => assertCaptureRecoveryState(stopped)).not.toThrow();
  });

  it.each(["root", "segment", "gap", "acknowledgement"] as const)(
    "rejects unknown %s fields",
    (layer) => {
      const state = acknowledgedState();
      const candidate = structuredClone(state) as unknown as Record<string, unknown>;
      if (layer === "root") candidate.patientName = "synthetic-only";
      if (layer === "segment") {
        (candidate.segments as Array<Record<string, unknown>>)[0]!.token = "forbidden";
      }
      if (layer === "gap") {
        (candidate.gaps as Array<Record<string, unknown>>)[0]!.claim = "forbidden";
      }
      if (layer === "acknowledgement") {
        const gap = (candidate.gaps as Array<Record<string, unknown>>)[0]!;
        (gap.acknowledgement as Record<string, unknown>).url = "forbidden";
      }
      expect(() => assertCaptureRecoveryState(candidate)).toThrow(
        "invalid_capture_recovery_state",
      );
    },
  );

  it("rejects sequence, chronology, and revision tampering", () => {
    const state = acknowledgedState();
    for (const mutate of [
      (value: CaptureRecoveryStateV1) => ({ ...value, localRevision: 0 }),
      (value: CaptureRecoveryStateV1) => ({ ...value, nextSequenceNumber: 9 }),
      (value: CaptureRecoveryStateV1) => ({
        ...value,
        gaps: [{ ...value.gaps[0]!, observedAt: STARTED_AT }],
      }),
    ]) {
      expect(() => assertCaptureRecoveryState(mutate(state))).toThrow(
        "invalid_capture_recovery_state",
      );
    }

    const stopped = stopRecoverySegment(recordingState(), OBSERVED_AT, 2);
    const overlapping = {
      ...stopped,
      nextSegmentOrdinal: 2,
      segments: [...stopped.segments, {
        ...stopped.segments[0]!,
        segmentId: "66666666-6666-4666-8666-666666666666",
        recoveryGapId: "77777777-7777-4777-8777-777777777777",
        ordinal: 1,
        firstSequenceNumber: 1,
      }],
    };
    expect(() => assertCaptureRecoveryState(overlapping)).toThrow(
      "invalid_capture_recovery_state",
    );
  });
});

function recordingState(): CaptureRecoveryStateV1 {
  return beginRecoverySegment(createCaptureRecoveryState(SESSION_ID), {
    segmentId: SEGMENT_ID,
    recoveryGapId: GAP_ID,
    startedAt: STARTED_AT,
    leaseGeneration: 1,
    captureAuthorizedUntil: "2026-09-02T12:15:00.000Z",
  });
}

function acknowledgedState(): CaptureRecoveryStateV1 {
  const closing = observeRecoveryGap(recordingState(), {
    reasonCode: "capture_backgrounded",
    observedAt: OBSERVED_AT,
    nextSequenceNumber: 1,
  });
  return acknowledgeRecoveryGap(confirmRecoverySourceClosed(closing), {
    acknowledgedAt: "2026-09-02T12:03:00.000Z",
    idempotencyKey: "ack-gap:44444444-4444-4444-8444-444444444444",
  });
}
