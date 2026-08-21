import { describe, expect, it } from "vitest";

import { ELECTRON_IPC_MAX_PAYLOAD_BYTES } from "./config.js";
import {
  parseBackendCaptureGrant,
  parseControllerStateEvent,
  parseIpcCommandResult,
  parseRendererCommand,
  parseStartAuthorityDecision,
  ProtocolValidationError,
} from "./protocol.js";

const backendGrant = {
  captureSessionId: "capture-synthetic-001",
  actorId: "actor-synthetic-001",
  consentRecordId: "consent-synthetic-001",
  consentStatus: "granted",
  sessionStatus: "authorized",
  source: "desktop_companion",
  sourceLeaseId: "source-lease-synthetic-001",
} as const;

describe("Electron IPC protocol", () => {
  it("accepts a strict renderer command without credentials", () => {
    expect(
      parseRendererCommand({
        schemaVersion: 1,
        kind: "start",
        requestId: "request-synthetic-001",
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: "start",
      requestId: "request-synthetic-001",
    });
  });

  it("keeps the backend grant on a separate main-process-only parser", () => {
    expect(parseBackendCaptureGrant(backendGrant)).toEqual(backendGrant);
    expect(() =>
      parseRendererCommand({
        schemaVersion: 1,
        kind: "start",
        requestId: "request-synthetic-002",
        captureCapability: {
          capabilityId: "capability-not-allowed",
          secret: "test-token-test-token",
          expiresAt: "2030-01-01T00:05:00.000Z",
        },
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseBackendCaptureGrant({
        ...backendGrant,
        workspaceApiKey: "must-never-enter-the-client",
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("validates an opaque provider-neutral authority capability", () => {
    const decision = {
      schemaVersion: 1,
      decision: "authorized",
      ...backendGrant,
      issuedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:05:00.000Z",
      captureCapability: {
        capabilityId: "capability-synthetic-001",
        secret: "test-token-test-token",
        expiresAt: "2030-01-01T00:05:00.000Z",
      },
    } as const;
    expect(parseStartAuthorityDecision(decision)).toEqual(decision);
    expect(JSON.stringify(decision)).not.toContain("recall");
  });

  it("rejects unauthorized consent/session claims and unknown commands", () => {
    expect(() =>
      parseBackendCaptureGrant({ ...backendGrant, consentStatus: "pending" }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseBackendCaptureGrant({ ...backendGrant, sessionStatus: "created" }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseRendererCommand({
        schemaVersion: 1,
        kind: "resume",
        requestId: "request-synthetic-003",
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("bounds every parsed IPC payload", () => {
    expect(() =>
      parseRendererCommand({
        schemaVersion: 1,
        kind: "start",
        requestId: "x".repeat(ELECTRON_IPC_MAX_PAYLOAD_BYTES),
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("rejects semantically inconsistent state and result messages", () => {
    expect(() =>
      parseControllerStateEvent({
        schemaVersion: 1,
        requestId: null,
        state: "failed",
        captureSessionId: null,
        reasonCode: null,
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseIpcCommandResult({
        schemaVersion: 1,
        requestId: "request-inconsistent-result",
        ok: true,
        errorCode: "adapter_failure",
      }),
    ).toThrow(ProtocolValidationError);
  });
});
