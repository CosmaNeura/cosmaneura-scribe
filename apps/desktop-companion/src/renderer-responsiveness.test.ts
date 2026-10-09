import { describe, expect, it, vi } from "vitest";
import { RendererResponsiveness } from "./renderer-responsiveness.js";

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

describe("bounded renderer responsiveness", () => {
  it("requires a timely main-issued round trip and expires proof even while one probe hangs", async () => {
    let now = 0;
    const next = deferred(), probe = vi.fn(() => next.promise);
    const liveness = new RendererResponsiveness(probe, () => now);
    expect(liveness.isResponsive()).toBe(false);
    await flush(); next.resolve(); await flush();
    expect(liveness.isResponsive()).toBe(true);
    const hung = deferred(); probe.mockReturnValue(hung.promise);
    await flush(); // the already queued second probe picks up the hung response
    now = 1499; expect(liveness.isResponsive()).toBe(true);
    now = 1500; expect(liveness.isResponsive()).toBe(false);
    for (let i = 0; i < 20; i++) expect(liveness.isResponsive()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("rejects late responses and can recover with a new timely probe", async () => {
    let now = 0;
    const late = deferred(), fresh = deferred(), probe = vi.fn(() => late.promise);
    const liveness = new RendererResponsiveness(probe, () => now);
    liveness.isResponsive(); await flush();
    now = 1000; late.resolve(); await flush();
    probe.mockReturnValue(fresh.promise);
    expect(liveness.isResponsive()).toBe(false);
    await flush(); now = 1010; fresh.resolve(); await flush();
    expect(liveness.isResponsive()).toBe(true);
  });
  it("does not accept an outstanding response after invalidation and contains synchronous/rejected failures", async () => {
    const pending = deferred(), probe = vi.fn((): Promise<unknown> => pending.promise);
    const liveness = new RendererResponsiveness(probe, () => 0);
    liveness.isResponsive(); await flush(); liveness.invalidate(); pending.resolve(); await flush();
    probe.mockImplementation(() => { throw new Error("Invented renderer destruction"); });
    expect(liveness.isResponsive()).toBe(false); await flush();
    probe.mockRejectedValue(new Error("Invented navigation"));
    expect(liveness.isResponsive()).toBe(false); await flush();
    expect(liveness.isResponsive()).toBe(false);
  });
});
