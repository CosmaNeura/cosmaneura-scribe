import { generateOpaqueSecret } from "./browser-handoff.js";
import { DesktopApiError } from "./desktop-api.js";
import type { DesktopApiClient } from "./desktop-api.js";
import type {
  DesktopProtectedState,
  DesktopSecureStateStore,
  PendingStopReceipt,
} from "./secure-state-store.js";
import { parseMetadataIdentifier } from "./protocol.js";

export class DesktopLifecycleCoordinator {
  readonly #api: DesktopApiClient;
  readonly #store: DesktopSecureStateStore;
  readonly #clock: () => Date;
  readonly #idempotencyKey: (operation: "heartbeat" | "stop") => string;

  constructor(options: {
    readonly api: DesktopApiClient;
    readonly store: DesktopSecureStateStore;
    readonly clock?: () => Date;
    readonly idempotencyKey?: (
      operation: "heartbeat" | "stop",
    ) => string;
  }) {
    this.#api = options.api;
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#idempotencyKey =
      options.idempotencyKey ??
      ((operation) => `${operation}.${generateOpaqueSecret()}`);
  }

  async heartbeat(capabilityId: string, signal: AbortSignal): Promise<void> {
    const state = await this.#store.load();
    const credential = state.sessionCredential;
    if (
      credential === null ||
      Date.parse(credential.expiresAt) <= this.#clock().getTime()
    ) {
      throw new DesktopApiError("unauthorized");
    }
    await this.#api.heartbeat(
      credential,
      parseMetadataIdentifier(capabilityId),
      this.#idempotencyKey("heartbeat"),
      signal,
    );
  }

  async recordStopIntent(capabilityId: string): Promise<void> {
    const validatedCapabilityId = parseMetadataIdentifier(capabilityId);
    const state = await this.#store.load();
    const credential = state.sessionCredential;
    if (credential === null) {
      throw new DesktopApiError("unauthorized");
    }
    const receipt: PendingStopReceipt = Object.freeze({
      captureSessionId: credential.grant.captureSessionId,
      capabilityId: validatedCapabilityId,
      idempotencyKey: this.#idempotencyKey("stop"),
      createdAt: this.#clock().toISOString(),
    });
    await this.#store.update((current) =>
      appendStopReceipt(current, receipt),
    );
    await this.flushPendingStops(new AbortController().signal);
  }

  async flushPendingStops(signal: AbortSignal): Promise<number> {
    let completed = 0;
    for (const receipt of (await this.#store.load()).pendingStopReceipts) {
      if (signal.aborted) {
        break;
      }
      const state = await this.#store.load();
      const credential = state.sessionCredential;
      if (
        credential === null ||
        Date.parse(credential.expiresAt) <= this.#clock().getTime()
      ) {
        break;
      }
      try {
        const decision = await this.#api.requestStop(
          credential,
          receipt.capabilityId,
          receipt.idempotencyKey,
          signal,
        );
        if (decision.sessionStatus !== "stopping") {
          break;
        }
      } catch (error) {
        if (error instanceof DesktopApiError) {
          break;
        }
        throw error;
      }
      await this.#store.update((current) =>
        removeStopReceipt(current, receipt.idempotencyKey),
      );
      completed += 1;
    }
    return completed;
  }
}

function appendStopReceipt(
  state: DesktopProtectedState,
  receipt: PendingStopReceipt,
): DesktopProtectedState {
  const existing = state.pendingStopReceipts.find(
    (candidate) =>
      candidate.captureSessionId === receipt.captureSessionId &&
      candidate.capabilityId === receipt.capabilityId,
  );
  return {
    ...state,
    pendingStopReceipts: Object.freeze([
      ...state.pendingStopReceipts,
      ...(existing === undefined ? [receipt] : []),
    ]),
  };
}

function removeStopReceipt(
  state: DesktopProtectedState,
  idempotencyKey: string,
): DesktopProtectedState {
  return {
    ...state,
    pendingStopReceipts: Object.freeze(
      state.pendingStopReceipts.filter(
        (receipt) => receipt.idempotencyKey !== idempotencyKey,
      ),
    ),
  };
}
