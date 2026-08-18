import { QueueInvariantError } from "../queue/errors";

const CAPTURE_FLOW_LOCK_NAME = "cosmaneura-capture-active-flow-v1";

export type ReleaseCaptureFlowLock = () => Promise<void>;

export interface CaptureFlowLockManager {
  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T>;
}

/** Holds one origin-wide capture flow until the page releases it or crashes. */
export async function acquireCaptureFlowLock(
  lockManager: CaptureFlowLockManager | null | undefined = globalThis.navigator?.locks,
): Promise<ReleaseCaptureFlowLock> {
  if (lockManager == null) {
    throw new QueueInvariantError("capture_flow_lock_unavailable");
  }

  let releaseHeldLock: (() => void) | undefined;
  let reportGrant: ((granted: boolean) => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeldLock = resolve;
  });
  const granted = new Promise<boolean>((resolve) => {
    reportGrant = resolve;
  });
  const request = lockManager.request(
    CAPTURE_FLOW_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      reportGrant?.(lock !== null);
      if (lock !== null) await held;
    },
  );
  void request.catch(() => reportGrant?.(false));
  if (!(await granted)) {
    await request.catch(() => undefined);
    throw new QueueInvariantError("capture_flow_already_active");
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseHeldLock?.();
    await request;
  };
}
