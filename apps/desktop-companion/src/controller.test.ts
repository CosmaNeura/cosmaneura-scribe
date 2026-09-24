import { describe, expect, it, vi } from "vitest";

import type { OneTimeCaptureCapability } from "./protocol.js";
import type { TrustedCaptureAuthority } from "./capture-authority.js";
import { OneTimeCapabilityRegistry } from "./capture-authority.js";
import {
  DesktopCaptureController,
  type DesktopCaptureControllerOptions,
} from "./controller.js";
import { MockDesktopCaptureAdapter } from "./mock-capture-adapter.js";
import {
  InMemoryRecordingIndicator,
  type PersistentRecordingIndicator,
  type RecordingIndicatorSnapshot,
} from "./recording-indicator.js";
import { SingleRecordingLease } from "./recording-lease.js";
import type {
  BackendCaptureGrant,
  RendererCommand,
  StartAuthorityDecision,
} from "./protocol.js";

type AuthorizedDecision = Extract<
  StartAuthorityDecision,
  { readonly decision: "authorized" }
>;

const NOW = new Date("2030-01-01T00:02:00.000Z");

function grant(suffix = "001"): BackendCaptureGrant {
  return {
    captureSessionId: `capture-synthetic-${suffix}`,
    actorId: `actor-synthetic-${suffix}`,
    consentRecordId: `consent-synthetic-${suffix}`,
    consentStatus: "granted",
    sessionStatus: "authorized",
    source: "desktop_companion",
    sourceLeaseId: `source-lease-synthetic-${suffix}`,
  };
}

function authorization(
  session: BackendCaptureGrant,
  capabilityId = `capability-${session.captureSessionId}`,
): AuthorizedDecision {
  return {
    schemaVersion: 1,
    decision: "authorized",
    ...session,
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:05:00.000Z",
    captureCapability: {
      capabilityId,
      secret: "test-token-test-token",
      expiresAt: "2030-01-01T00:05:00.000Z",
    },
  };
}

class StaticAuthority implements TrustedCaptureAuthority {
  readonly calls: BackendCaptureGrant[] = [];
  readonly #response: unknown;

  constructor(response: unknown) {
    this.#response = response;
  }

  authorizeStart(
    session: BackendCaptureGrant,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) {
      return Promise.reject(new Error("synthetic authority aborted"));
    }
    this.calls.push(session);
    return Promise.resolve(this.#response);
  }
}

class RejectingAuthority implements TrustedCaptureAuthority {
  authorizeStart(
    session: BackendCaptureGrant,
    signal: AbortSignal,
  ): Promise<unknown> {
    void session;
    void signal;
    return Promise.reject(new Error("synthetic authority failure"));
  }
}

class HungAuthority implements TrustedCaptureAuthority {
  aborted = false;

  authorizeStart(
    _session: BackendCaptureGrant,
    signal: AbortSignal,
  ): Promise<unknown> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        this.aborted = true;
        reject(new Error("synthetic authority abort"));
      });
    });
  }
}

function options(
  authority: TrustedCaptureAuthority,
  lease = new SingleRecordingLease(),
  capabilityRegistry = new OneTimeCapabilityRegistry(),
): DesktopCaptureControllerOptions {
  return {
    enabled: true,
    authority,
    authorityTimeoutMs: 100,
    capabilityRegistry,
    clock: () => NOW,
    lease,
  };
}

function command(
  kind: RendererCommand["kind"],
  requestId: string,
): RendererCommand {
  return { schemaVersion: 1, kind, requestId };
}

class TerminationFailureAdapter extends MockDesktopCaptureAdapter {
  override abort(signal: AbortSignal): Promise<void> {
    void signal;
    return Promise.reject(new Error("synthetic abort failure"));
  }

  override shutdown(signal: AbortSignal): Promise<void> {
    void signal;
    return Promise.reject(new Error("synthetic shutdown failure"));
  }
}

class StopFailureAdapter extends MockDesktopCaptureAdapter {
  override stop(signal: AbortSignal): Promise<void> {
    void signal;
    return Promise.reject(new Error("synthetic stop failure"));
  }
}

class StartFailureAdapter extends MockDesktopCaptureAdapter {
  starts = 0;

  override start(
    capability: OneTimeCaptureCapability,
    signal: AbortSignal,
  ): Promise<void> {
    if (capability.secret.length === 0 || signal.aborted) {
      return Promise.reject(new Error("synthetic capability failure"));
    }
    this.starts += 1;
    return Promise.reject(new Error("synthetic start failure"));
  }
}

class CapabilityProbeAdapter extends MockDesktopCaptureAdapter {
  received: OneTimeCaptureCapability | null = null;

  override start(
    capability: OneTimeCaptureCapability,
    signal: AbortSignal,
  ): Promise<void> {
    this.received = capability;
    return super.start(capability, signal);
  }
}

class HungStartAdapter extends MockDesktopCaptureAdapter {
  startAborted = false;

  override start(
    capability: OneTimeCaptureCapability,
    signal: AbortSignal,
  ): Promise<void> {
    if (capability.secret.length === 0) {
      return Promise.reject(new Error("synthetic capability failure"));
    }
    this.operations.push("start");
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          this.startAborted = true;
          reject(new Error("synthetic start abort"));
        },
        { once: true },
      );
    });
  }
}

class NonCooperativeStartAndAbortAdapter extends MockDesktopCaptureAdapter {
  received: OneTimeCaptureCapability | null = null;

  override start(
    capability: OneTimeCaptureCapability,
    signal: AbortSignal,
  ): Promise<void> {
    void signal;
    this.received = capability;
    this.operations.push("start");
    return new Promise(() => undefined);
  }

  override abort(signal: AbortSignal): Promise<void> {
    void signal;
    this.operations.push("abort");
    return new Promise(() => undefined);
  }
}

class NonCooperativeInitializeAdapter extends MockDesktopCaptureAdapter {
  override initialize(signal: AbortSignal): Promise<"ready"> {
    void signal;
    this.operations.push("initialize");
    return new Promise(() => undefined);
  }
}

class NonCooperativeRefreshAdapter extends MockDesktopCaptureAdapter {
  override refreshPermissions(signal: AbortSignal): Promise<"ready"> {
    void signal;
    this.operations.push("refresh_permissions");
    return new Promise(() => undefined);
  }
}

class InactiveIndicatorFailure implements PersistentRecordingIndicator {
  readonly history: RecordingIndicatorSnapshot[] = [];

  publish(snapshot: RecordingIndicatorSnapshot): Promise<void> {
    if (snapshot.phase === "inactive") {
      return Promise.reject(new Error("synthetic indicator failure"));
    }
    this.history.push(snapshot);
    return Promise.resolve();
  }
}

describe("DesktopCaptureController", () => {
  it("bounds non-cooperative initialization and drains queued shutdown", async () => {
    vi.useFakeTimers();
    try {
      const session = grant("hung-initialize");
      const adapter = new NonCooperativeInitializeAdapter();
      const controller = new DesktopCaptureController(
        adapter,
        new InMemoryRecordingIndicator(),
        {
          ...options(new StaticAuthority(authorization(session))),
          captureOperationTimeoutMs: 25,
        },
      );
      const states: string[] = [];
      controller.subscribe((event) => states.push(event.state));
      const initialize = controller.initializeFromBackend(
        session,
        "request-init",
      );
      const initializeRejection = expect(initialize).rejects.toMatchObject({
        code: "adapter_failure",
      });
      const shutdown = controller.shutdownFromMain("request-shutdown");

      await vi.advanceTimersByTimeAsync(25);
      await initializeRejection;
      await expect(shutdown).resolves.toBeUndefined();
      expect(states).toEqual(["failed", "stopped"]);
      expect(adapter.operations).toEqual(["initialize", "shutdown"]);
      await expect(
        controller.initializeFromBackend(grant("replacement"), "request-regrant"),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds non-cooperative permission refresh and drains queued shutdown", async () => {
    vi.useFakeTimers();
    try {
      const session = grant("hung-refresh");
      const adapter = new NonCooperativeRefreshAdapter("permission_required");
      const indicator = new InMemoryRecordingIndicator();
      const controller = new DesktopCaptureController(
        adapter,
        indicator,
        {
          ...options(new StaticAuthority(authorization(session))),
          captureOperationTimeoutMs: 25,
        },
      );
      const states: string[] = [];
      controller.subscribe((event) => states.push(event.state));
      await controller.initializeFromBackend(session, "request-init");
      const refresh = controller.handleRendererCommand(
        command("refresh_permissions", "request-refresh"),
      );
      const refreshRejection = expect(refresh).rejects.toMatchObject({
        code: "adapter_failure",
      });
      const shutdown = controller.shutdownFromMain("request-shutdown");

      await vi.advanceTimersByTimeAsync(25);
      await refreshRejection;
      await expect(shutdown).resolves.toBeUndefined();
      expect(states).toEqual(["permission_required", "failed", "stopped"]);
      expect(adapter.operations).toEqual([
        "initialize",
        "refresh_permissions",
        "shutdown",
      ]);
      expect(indicator.history).toContainEqual({
        visibility: "persistent",
        visible: true,
        phase: "failed",
        captureSessionId: session.captureSessionId,
      });
      await expect(
        controller.handleRendererCommand(command("start", "request-replay")),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is disabled and denies authority by default", async () => {
    const disabled = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
    );
    await expect(
      disabled.initializeFromBackend(grant(), "request-disabled"),
    ).rejects.toMatchObject({ code: "feature_disabled" });

    const session = grant("default-authority");
    const denied = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      {
        enabled: true,
        clock: () => NOW,
        lease: new SingleRecordingLease(),
        capabilityRegistry: new OneTimeCapabilityRegistry(),
      },
    );
    await denied.initializeFromBackend(session, "request-init");
    await expect(
      denied.handleRendererCommand(command("start", "request-start")),
    ).rejects.toMatchObject({ code: "authority_revoked" });
  });

  it("revalidates authority and consumes only a minimal capability at start", async () => {
    const session = grant();
    const authority = new StaticAuthority(authorization(session));
    const adapter = new CapabilityProbeAdapter("ready");
    const indicator = new InMemoryRecordingIndicator();
    const controller = new DesktopCaptureController(
      adapter,
      indicator,
      options(authority),
    );
    const states: string[] = [];
    controller.subscribe((event) => states.push(event.state));

    await controller.initializeFromBackend(session, "request-initialize");
    expect(authority.calls).toEqual([]);
    await controller.handleRendererCommand(command("start", "request-start"));
    expect(authority.calls).toEqual([session]);
    expect(adapter.received?.secret).toBe("");
    expect(indicator.current()).toMatchObject({ visible: true, phase: "recording" });
    await controller.handleRendererCommand(command("stop", "request-stop"));

    expect(states).toEqual(["ready", "recording", "stopped"]);
    expect(adapter.operations).toEqual(["initialize", "start", "stop"]);
    expect(indicator.current()).toEqual({
      visibility: "persistent",
      visible: false,
      phase: "inactive",
      captureSessionId: null,
    });
    expect(JSON.stringify(adapter)).not.toContain("test-token-test-token");
    expect(JSON.stringify(controller.snapshot())).not.toContain(
      "test-token-test-token",
    );
  });

  it("does not call authority until the meeting is ready", async () => {
    const session = grant("not-ready");
    const authority = new StaticAuthority(authorization(session));
    const controller = new DesktopCaptureController(
      new MockDesktopCaptureAdapter("meeting_detected"),
      new InMemoryRecordingIndicator(),
      options(authority),
    );
    await controller.initializeFromBackend(session, "request-initialize");
    await expect(
      controller.handleRendererCommand(command("start", "request-start")),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    expect(authority.calls).toEqual([]);
  });

  it("fails closed when authority is revoked or changes identity/lease", async () => {
    const revokedSession = grant("revoked");
    const revoked = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority({
          schemaVersion: 1,
          decision: "denied",
          denialCode: "revoked",
        }),
      ),
    );
    await revoked.initializeFromBackend(revokedSession, "request-revoked-init");
    await expect(
      revoked.handleRendererCommand(command("start", "request-revoked-start")),
    ).rejects.toMatchObject({ code: "authority_revoked" });

    const changedSession = grant("changed");
    const changedDecision = authorization(changedSession);
    const changed = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority({
          ...changedDecision,
          actorId: "actor-synthetic-different",
          sourceLeaseId: "source-lease-synthetic-different",
        }),
      ),
    );
    await changed.initializeFromBackend(changedSession, "request-changed-init");
    await expect(
      changed.handleRendererCommand(command("start", "request-changed-start")),
    ).rejects.toMatchObject({ code: "authority_changed" });
  });

  it.each([
    {
      label: "stale",
      issuedAt: "2029-12-31T23:55:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    {
      label: "overlong",
      issuedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:05:00.001Z",
    },
  ])("rejects a $label authority window", async ({ issuedAt, expiresAt }) => {
    const session = grant(`window-${issuedAt.length}-${expiresAt.length}`);
    const decision = authorization(session);
    const controller = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority({
          ...decision,
          issuedAt,
          expiresAt,
          captureCapability: {
            ...decision.captureCapability,
            expiresAt,
          },
        }),
      ),
    );
    await controller.initializeFromBackend(session, "request-window-init");
    await expect(
      controller.handleRendererCommand(command("start", "request-window-start")),
    ).rejects.toMatchObject({ code: "authority_stale" });
  });

  it("fails closed when the backend authority check rejects", async () => {
    const session = grant("backend-failure");
    const adapter = new MockDesktopCaptureAdapter();
    const controller = new DesktopCaptureController(
      adapter,
      new InMemoryRecordingIndicator(),
      options(new RejectingAuthority()),
    );
    await controller.initializeFromBackend(session, "request-init");
    await expect(
      controller.handleRendererCommand(command("start", "request-start")),
    ).rejects.toMatchObject({ code: "authority_unavailable" });
    expect(adapter.operations).toEqual(["initialize"]);
  });

  it("times out and aborts a hung authority check", async () => {
    vi.useFakeTimers();
    try {
      const session = grant("hung");
      const authority = new HungAuthority();
      const adapter = new MockDesktopCaptureAdapter();
      const controller = new DesktopCaptureController(
        adapter,
        new InMemoryRecordingIndicator(),
        {
          ...options(authority),
          authorityTimeoutMs: 25,
        },
      );
      await controller.initializeFromBackend(session, "request-init");
      const start = controller.handleRendererCommand(
        command("start", "request-start"),
      );
      const rejection = expect(start).rejects.toMatchObject({
        code: "authority_unavailable",
      });
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(authority.aborted).toBe(true);
      expect(adapter.operations).toEqual(["initialize"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents capability replay across controller instances", async () => {
    const session = grant("replay");
    const registry = new OneTimeCapabilityRegistry();
    const lease = new SingleRecordingLease();
    const first = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(new StaticAuthority(authorization(session, "capability-replay")), lease, registry),
    );
    await first.initializeFromBackend(session, "request-first-init");
    await first.handleRendererCommand(command("start", "request-first-start"));
    await first.handleRendererCommand(command("stop", "request-first-stop"));

    const second = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(new StaticAuthority(authorization(session, "capability-replay")), lease, registry),
    );
    await second.initializeFromBackend(session, "request-second-init");
    await expect(
      second.handleRendererCommand(command("start", "request-second-start")),
    ).rejects.toMatchObject({ code: "capability_replayed" });
  });

  it("uses a unique controller owner even for the same capture session", async () => {
    const session = grant("same");
    const lease = new SingleRecordingLease();
    const registry = new OneTimeCapabilityRegistry();
    const first = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority(authorization(session, "capability-first")),
        lease,
        registry,
      ),
    );
    const second = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority(authorization(session, "capability-second")),
        lease,
        registry,
      ),
    );
    await first.initializeFromBackend(session, "request-first-init");
    await second.initializeFromBackend(session, "request-second-init");
    await first.handleRendererCommand(command("start", "request-first-start"));
    await expect(
      second.handleRendererCommand(command("start", "request-second-start")),
    ).rejects.toMatchObject({ code: "lease_unavailable" });
  });

  it.each(["network_lost", "device_changed"] as const)(
    "makes %s terminal, revokes authority, and holds the lease until shutdown",
    async (kind) => {
      const session = grant(kind);
      const lease = new SingleRecordingLease();
      const adapter = new MockDesktopCaptureAdapter();
      const indicator = new InMemoryRecordingIndicator();
      const controller = new DesktopCaptureController(
        adapter,
        indicator,
        options(new StaticAuthority(authorization(session)), lease),
      );
      await controller.initializeFromBackend(session, "request-init-terminal");
      await controller.handleRendererCommand(
        command("start", "request-start-terminal"),
      );
      adapter.emit({ kind });
      await controller.settled();

      expect(controller.snapshot()).toMatchObject({ state: "failed", reasonCode: kind });
      expect(adapter.operations).toContain("abort");
      expect(indicator.current()).toMatchObject({ visible: true, phase: "failed" });
      adapter.emit({ kind: "ready" });
      await controller.settled();
      expect(controller.snapshot()).toMatchObject({ state: "failed", reasonCode: kind });
      await expect(
        controller.handleRendererCommand(command("start", "request-restart")),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      await expect(
        controller.initializeFromBackend(grant("new"), "request-reinitialize"),
      ).rejects.toMatchObject({ code: "invalid_transition" });

      const competingSession = grant(`other-${kind}`);
      const competing = new DesktopCaptureController(
        new MockDesktopCaptureAdapter(),
        new InMemoryRecordingIndicator(),
        options(
          new StaticAuthority(authorization(competingSession)),
          lease,
        ),
      );
      await competing.initializeFromBackend(
        competingSession,
        "request-other-init",
      );
      await expect(
        competing.handleRendererCommand(command("start", "request-other-start")),
      ).rejects.toMatchObject({ code: "lease_unavailable" });

      await controller.shutdownFromMain("request-terminal-shutdown");
      expect(indicator.current()).toMatchObject({ visible: false, phase: "inactive" });
      await expect(
        controller.initializeFromBackend(grant("after"), "request-after-shutdown"),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    },
  );

  it("keeps the warning and lease when forced native termination is uncertain", async () => {
    const session = grant("uncertain");
    const lease = new SingleRecordingLease();
    const adapter = new TerminationFailureAdapter();
    const indicator = new InMemoryRecordingIndicator();
    const controller = new DesktopCaptureController(
      adapter,
      indicator,
      options(new StaticAuthority(authorization(session)), lease),
    );
    await controller.initializeFromBackend(session, "request-init");
    await controller.handleRendererCommand(command("start", "request-start"));
    adapter.emit({ kind: "network_lost" });
    await controller.settled();
    expect(indicator.current()).toMatchObject({ visible: true, phase: "failed" });

    await expect(
      controller.shutdownFromMain("request-uncertain-shutdown"),
    ).rejects.toMatchObject({ code: "adapter_failure" });
    const competingSession = grant("competing");
    const competing = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority(authorization(competingSession)),
        lease,
      ),
    );
    await competing.initializeFromBackend(competingSession, "request-competing-init");
    await expect(
      competing.handleRendererCommand(command("start", "request-competing-start")),
    ).rejects.toMatchObject({ code: "lease_unavailable" });
  });

  it("fails closed and consumes the capability when direct start fails", async () => {
    const session = grant("start-failure");
    const registry = new OneTimeCapabilityRegistry();
    const adapter = new StartFailureAdapter();
    const controller = new DesktopCaptureController(
      adapter,
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority(authorization(session, "capability-start-failure")),
        new SingleRecordingLease(),
        registry,
      ),
    );
    await controller.initializeFromBackend(session, "request-init");
    await expect(
      controller.handleRendererCommand(command("start", "request-start")),
    ).rejects.toMatchObject({ code: "adapter_failure" });
    expect(adapter.starts).toBe(1);
    expect(adapter.operations).toContain("abort");
    expect(controller.snapshot()).toMatchObject({ state: "failed" });
    expect(JSON.stringify(controller.snapshot())).not.toContain(
      "test-token-test-token",
    );
  });

  it("aborts a hung start and enters terminal failure with the warning visible", async () => {
    vi.useFakeTimers();
    try {
      const session = grant("hung-start");
      const adapter = new HungStartAdapter();
      const indicator = new InMemoryRecordingIndicator();
      const controller = new DesktopCaptureController(
        adapter,
        indicator,
        {
          ...options(new StaticAuthority(authorization(session))),
          captureOperationTimeoutMs: 25,
        },
      );
      await controller.initializeFromBackend(session, "request-init");
      const start = controller.handleRendererCommand(
        command("start", "request-start"),
      );
      const rejection = expect(start).rejects.toMatchObject({
        code: "adapter_failure",
      });
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(adapter.startAborted).toBe(true);
      expect(adapter.operations).toContain("abort");
      expect(controller.snapshot()).toMatchObject({ state: "failed" });
      expect(indicator.current()).toMatchObject({
        visible: true,
        phase: "failed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds non-cooperative start cleanup and retains warning and lease", async () => {
    vi.useFakeTimers();
    try {
      const session = grant("non-cooperative-start");
      const lease = new SingleRecordingLease();
      const adapter = new NonCooperativeStartAndAbortAdapter();
      const indicator = new InMemoryRecordingIndicator();
      const controller = new DesktopCaptureController(
        adapter,
        indicator,
        {
          ...options(new StaticAuthority(authorization(session)), lease),
          captureOperationTimeoutMs: 25,
        },
      );
      await controller.initializeFromBackend(session, "request-init");
      const start = controller.handleRendererCommand(
        command("start", "request-start"),
      );
      const rejection = expect(start).rejects.toMatchObject({
        code: "adapter_failure",
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(adapter.received?.secret).toBe("");
      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      expect(adapter.operations).toEqual(["initialize", "start", "abort"]);
      expect(controller.snapshot()).toMatchObject({
        state: "failed",
        reasonCode: "adapter_failure",
      });
      expect(indicator.current()).toMatchObject({
        visible: true,
        phase: "failed",
      });
      await expect(
        controller.handleRendererCommand(command("start", "request-replay")),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      await expect(
        controller.initializeFromBackend(grant("replacement"), "request-regrant"),
      ).rejects.toMatchObject({ code: "invalid_transition" });

      const competingSession = grant("competing-after-timeout");
      const competing = new DesktopCaptureController(
        new MockDesktopCaptureAdapter(),
        new InMemoryRecordingIndicator(),
        options(
          new StaticAuthority(authorization(competingSession)),
          lease,
        ),
      );
      await competing.initializeFromBackend(
        competingSession,
        "request-competing-init",
      );
      await expect(
        competing.handleRendererCommand(
          command("start", "request-competing-start"),
        ),
      ).rejects.toMatchObject({ code: "lease_unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces abort and retains the lease after a direct stop failure", async () => {
    const session = grant("stop-failure");
    const lease = new SingleRecordingLease();
    const adapter = new StopFailureAdapter();
    const indicator = new InMemoryRecordingIndicator();
    const controller = new DesktopCaptureController(
      adapter,
      indicator,
      options(new StaticAuthority(authorization(session)), lease),
    );
    await controller.initializeFromBackend(session, "request-init");
    await controller.handleRendererCommand(command("start", "request-start"));
    await expect(
      controller.handleRendererCommand(command("stop", "request-stop")),
    ).rejects.toMatchObject({ code: "adapter_failure" });

    expect(adapter.operations).toContain("abort");
    expect(controller.snapshot()).toMatchObject({ state: "failed" });
    expect(indicator.current()).toMatchObject({ visible: true, phase: "failed" });

    const competingSession = grant("stop-competing");
    const competing = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority(authorization(competingSession)),
        lease,
      ),
    );
    await competing.initializeFromBackend(competingSession, "request-other-init");
    await expect(
      competing.handleRendererCommand(command("start", "request-other-start")),
    ).rejects.toMatchObject({ code: "lease_unavailable" });
  });

  it("retains the lease when clearing the persistent indicator fails", async () => {
    const session = grant("indicator");
    const lease = new SingleRecordingLease();
    const controller = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InactiveIndicatorFailure(),
      options(new StaticAuthority(authorization(session)), lease),
    );
    await controller.initializeFromBackend(session, "request-init");
    await controller.handleRendererCommand(command("start", "request-start"));
    await expect(
      controller.handleRendererCommand(command("stop", "request-stop")),
    ).rejects.toMatchObject({ code: "indicator_failure" });

    const competingSession = grant("other-indicator");
    const competing = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      options(
        new StaticAuthority(authorization(competingSession)),
        lease,
      ),
    );
    await competing.initializeFromBackend(competingSession, "request-other-init");
    await expect(
      competing.handleRendererCommand(command("start", "request-other-start")),
    ).rejects.toMatchObject({ code: "lease_unavailable" });
  });

  it("retries an incomplete shutdown after the indicator becomes available", async () => {
    const session = grant("shutdown-indicator"), lease = new SingleRecordingLease();
    const indicator = new InMemoryRecordingIndicator();
    let refuse = true;
    const controller = new DesktopCaptureController(new MockDesktopCaptureAdapter(), {
      publish: value => !value.visible && refuse ? Promise.reject(new Error("invented indicator failure")) : indicator.publish(value),
    }, options(new StaticAuthority(authorization(session)), lease));
    await controller.initializeFromBackend(session, "request-init");
    await controller.handleRendererCommand(command("start", "request-start"));
    await expect(controller.shutdownFromMain("request-shutdown")).rejects.toMatchObject({ code: "indicator_failure" });
    expect(controller.snapshot().state).toBe("failed");
    refuse = false;
    await controller.shutdownFromMain("request-retry");
    expect(controller.snapshot().state).toBe("stopped"); expect(indicator.current()).toMatchObject({ visible: false });
    const next = grant("after-shutdown-indicator");
    const other = new DesktopCaptureController(new MockDesktopCaptureAdapter(), new InMemoryRecordingIndicator(),
      options(new StaticAuthority(authorization(next)), lease));
    await other.initializeFromBackend(next, "request-other-init");
    await other.handleRendererCommand(command("start", "request-other-start"));
    await other.shutdownFromMain("request-other-close");
  });
});
