import { afterEach, expect, it, vi } from "vitest";
import { nativePassagePlayer } from "./native-passage";
import type { ProviderNativePlugin } from "./native-plugin";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { revision: id(1), workspaceId: id(2), bindingRef: "scribe_capture_binding_01m5x6bf6ffp2bggh1ng2ca18p" };
const playing = { available: true, playing: true, positionMs: 0, durationMs: 1000 };
function fixture() {
  const parent = new AbortController(), signal = new AbortController();
  const play = vi.fn(async (): Promise<unknown> => playing), read = vi.fn(async (): Promise<unknown> => playing), stop = vi.fn(async () => {});
  let authorized = true;
  const plugin = { playProviderPassage: play, readProviderPassage: read, stopProviderPassage: stop } as unknown as ProviderNativePlugin;
  const player = nativePassagePlayer(plugin, scope, [parent.signal], () => { if (!authorized) throw new Error("Revoked"); });
  return { parent, signal, play, read, stop, player, revoke: () => { authorized = false; } };
}
afterEach(() => { vi.restoreAllMocks(); });
it("sends only exact mount and segment IDs; keeps native player data outside the renderer", async () => {
  const f = fixture(), value = await f.player(id(3), id(4), f.signal.signal);
  expect(f.play).toHaveBeenCalledWith({ ...scope, requestId: expect.any(String), sessionId: id(3), segmentId: id(4) });
  expect(value && "native" in value).toBe(true);
  if (!value || !("native" in value)) throw new Error("Missing native capability");
  expect(await value.native.read()).toEqual({ playing: true, positionMs: 0, durationMs: 1000 });
  await value.native.stop();expect(f.stop).toHaveBeenCalledTimes(1);
});
it("cancels a pending native authorization immediately and fences its late result", async () => {
  const f = fixture();let finish!: (v: unknown) => void;
  f.play.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.player(id(3), id(4), f.signal.signal), rejection = expect(pending).rejects.toThrow();
  f.signal.abort();await rejection;expect(f.stop).toHaveBeenCalledTimes(1);
  finish(playing);await Promise.resolve();expect(f.read).not.toHaveBeenCalled();
});
it("stops active audio on account or mounted surface teardown", async () => {
  const f = fixture();await f.player(id(3), id(4), f.signal.signal);f.parent.abort();
  expect(f.stop).toHaveBeenCalledTimes(1);
});
it("refuses metadata carrying audio or an excessive duration and stops the owned request", async () => {
  for (const value of [{ ...playing, wavBase64: "bad" }, { ...playing, durationMs: 30_001 }]) {
    const f = fixture();f.play.mockResolvedValue(value);
    await expect(f.player(id(3), id(4), f.signal.signal)).rejects.toThrow();expect(f.stop).toHaveBeenCalledTimes(1);
  }
});
it("returns unavailable for historical captures and never creates a recording", async () => {
  const f = fixture();f.play.mockResolvedValue({ available: false });
  expect(await f.player(id(3), id(4), f.signal.signal)).toBeNull();expect(f.read).not.toHaveBeenCalled();
});
it("stops if authority changes during a player status read", async () => {
  const f = fixture(), value = await f.player(id(3), id(4), f.signal.signal);
  if (!value || !("native" in value)) throw new Error("Missing native capability");
  f.revoke();await expect(value.native.read()).rejects.toThrow();expect(f.stop).toHaveBeenCalledTimes(1);
});
