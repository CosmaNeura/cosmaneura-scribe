import { describe, expect, it, vi } from "vitest";
import { subscribeIOSRecordingOpen } from "./recording-open";

function fixture(initialPending = false) {
  let pending = initialPending, listener: (value: unknown) => void = () => undefined;
  const removed = vi.fn(async () => undefined);
  const source = {
    addListener: vi.fn(async (_name: "recordingOpen", received: (value: unknown) => void) => {
      listener = received; return { remove: removed };
    }),
    takeRecordingOpenRequest: vi.fn(async () => { const value = pending; pending = false; return { version: 1, pending: value }; }),
  };
  return { source, removed, event: (value: unknown = { version: 1 }) => { pending = true; listener(value); } };
}

describe("iOS recording navigation", () => {
  it("consumes a cold-launch request after installing the listener, without a recording command", async () => {
    const f = fixture(true), opened = vi.fn();
    const handle = await subscribeIOSRecordingOpen(f.source, opened);
    expect(f.source.addListener).toHaveBeenCalledWith("recordingOpen", expect.any(Function));
    expect(opened).toHaveBeenCalledOnce();
    expect(f.source.takeRecordingOpenRequest).toHaveBeenCalledOnce();
    await handle.remove(); expect(f.removed).toHaveBeenCalledOnce();
  });
  it("routes a mounted-app event once and ignores unbounded or identity-bearing event data", async () => {
    const f = fixture(), opened = vi.fn();
    const handle = await subscribeIOSRecordingOpen(f.source, opened);
    f.event({ version: 1, patient: "Synthetic name" }); await Promise.resolve();
    expect(opened).not.toHaveBeenCalled();
    f.event(); await Promise.resolve(); await Promise.resolve();
    expect(opened).toHaveBeenCalledOnce();
    await handle.remove(); f.event(); await Promise.resolve();
    expect(opened).toHaveBeenCalledOnce();
  });
  it("closes a late read before it can route a recording", async () => {
    const f = fixture(), opened = vi.fn();
    const handle = await subscribeIOSRecordingOpen(f.source, opened);
    let resolve!: (value: { version: number; pending: boolean }) => void;
    f.source.takeRecordingOpenRequest.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.event(); await handle.remove(); resolve({ version: 1, pending: true });
    await Promise.resolve(); expect(opened).not.toHaveBeenCalled();
  });
});
