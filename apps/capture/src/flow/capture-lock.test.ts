import { describe, expect, it } from "vitest";

import { acquireCaptureFlowLock } from "./capture-lock";

describe("capture flow origin lock", () => {
  it("allows one active page and releases it for relaunch", async () => {
    const locks = new FakeLockManager();
    const releaseFirst = await acquireCaptureFlowLock(locks);
    await expect(acquireCaptureFlowLock(locks)).rejects.toThrow(
      "capture_flow_already_active",
    );
    await releaseFirst();
    const releaseSecond = await acquireCaptureFlowLock(locks);
    await releaseSecond();
  });

  it("fails closed when Web Locks are unavailable", async () => {
    await expect(acquireCaptureFlowLock(null)).rejects.toThrow(
      "capture_flow_lock_unavailable",
    );
  });
});

class FakeLockManager {
  #held = false;

  public async request<T>(
    _name: string,
    _options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T> {
    if (this.#held) return callback(null);
    this.#held = true;
    try {
      return await callback({ name: "capture", mode: "exclusive" });
    } finally {
      this.#held = false;
    }
  }
}
