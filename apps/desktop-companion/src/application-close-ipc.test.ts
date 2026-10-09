import { describe, expect, it, vi } from "vitest";
import { installApplicationClose, installApplicationClosePreload, type ApplicationCloseMainPort } from "./application-close-ipc.js";

function fixture() {
  const frame = { url: "app://cosmas/provider.html" }, renderer = { id: 17, mainFrame: frame, isDestroyed: vi.fn(() => false) };
  const event = { sender: renderer, senderFrame: frame };
  let handler!: Parameters<ApplicationCloseMainPort["handle"]>[1];
  const ipc = { handle: vi.fn((_channel, listener) => { handler = listener; }), removeHandler: vi.fn() };
  const close = vi.fn(), remove = installApplicationClose(ipc, renderer, close);
  return { frame, renderer, event, ipc, close, remove, invoke: (...args: unknown[]) => handler(event, ...args) };
}
describe("fixed application close boundary", () => {
  it("accepts only a zero-argument close from the current packaged top frame", () => {
    const f = fixture(); expect(f.invoke()).toBeNull(); expect(f.close).toHaveBeenCalledOnce();
    expect(f.ipc.handle).toHaveBeenCalledWith("scribe:application:close:v1", expect.any(Function));
  });
  it.each(["sender", "subframe", "missing-frame", "external", "other-asset", "query", "destroyed", "removed", "argument"])("rejects %s before shutdown", fault => {
    const f = fixture();
    if (fault === "sender") f.event.sender = { ...f.renderer, id: 18 };
    if (fault === "subframe") f.event.senderFrame = { ...f.frame };
    if (fault === "missing-frame") f.event.senderFrame = null as unknown as typeof f.frame;
    if (fault === "external") f.frame.url = "https://example.invalid/";
    if (fault === "other-asset") f.frame.url = "app://cosmas/desktop-start.js";
    if (fault === "query") f.frame.url += "?close=true";
    if (fault === "destroyed") f.renderer.isDestroyed.mockReturnValue(true);
    if (fault === "removed") f.remove();
    expect(() => fault === "argument" ? f.invoke({ command: "close" }) : f.invoke()).toThrow("could not close");
    expect(f.close).not.toHaveBeenCalled();
  });
  it("preload exposes one immutable close action without a generic send", async () => {
    let api!: { close(...args: unknown[]): Promise<void> };
    const context = { exposeInMainWorld: vi.fn((_name, value) => { api = value; }) };
    const ipc = { invoke: vi.fn(async (): Promise<unknown> => null) };
    installApplicationClosePreload(context, ipc);
    expect(Object.keys(api)).toEqual(["close"]); expect(Object.isFrozen(api)).toBe(true);
    await api.close(); expect(ipc.invoke).toHaveBeenCalledWith("scribe:application:close:v1");
    await expect(api.close("argument")).rejects.toThrow(); expect(ipc.invoke).toHaveBeenCalledOnce();
    ipc.invoke.mockResolvedValue("unexpected"); await expect(api.close()).rejects.toThrow();
  });
});
