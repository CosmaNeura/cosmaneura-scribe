import { expect, it, vi } from "vitest";
import { scopedSignInPreparation, setupSignInPreparation } from "./signin-preparation";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

it("coalesces pending setup and fresh consent calls, keeping tokens wholly behind the native callbacks", async () => {
  const minted = gate(), prepare = vi.fn<(id: string, signal: AbortSignal) => Promise<void>>(async () => minted.promise), abandon = vi.fn(async () => undefined);
  const host = new AbortController(), setup = new AbortController(), action = new AbortController();
  const handle = scopedSignInPreparation({ signal: host.signal, current: () => undefined, prepare, abandon });
  const first = handle.prepare(setup.signal), second = handle.prepare(action.signal);
  await flush(); expect(prepare).toHaveBeenCalledOnce(); expect(second).toBe(first);
  expect(prepare.mock.calls[0]![0]).toMatch(/^[0-9a-f-]{36}$/u);
  minted.resolve(); await first; expect(abandon).not.toHaveBeenCalled();
  action.abort(); await flush(); expect(abandon).toHaveBeenCalledWith(prepare.mock.calls[0]![0]);
});

it("cancels the exact owner before a resistant pending reply settles, and uses a different owner for the next setup", async () => {
  const ack = gate(), stopped = gate();
  const prepare = vi.fn<(id: string, signal: AbortSignal) => Promise<void>>(async () => ack.promise);
  const abandon = vi.fn(async () => stopped.promise), host = new AbortController(), old = new AbortController();
  const handle = scopedSignInPreparation({ signal: host.signal, current: () => undefined, prepare, abandon });
  const pending = handle.prepare(old.signal); void pending.catch(() => undefined);
  await flush(); const id = prepare.mock.calls[0]![0]; old.abort(); await flush();
  expect(abandon).toHaveBeenCalledWith(id); expect(prepare.mock.calls[0]![1].aborted).toBe(true);
  const next = handle.prepare(new AbortController().signal); await flush(); expect(prepare).toHaveBeenCalledOnce();
  ack.resolve(); stopped.resolve(); await expect(pending).rejects.toThrow(); await next;
  expect(prepare).toHaveBeenCalledTimes(2); expect(prepare.mock.calls[1]![0]).not.toBe(id);
});

it("refuses warm work after revision/account/mount revocation and joins host cancellation", async () => {
  const host = new AbortController(), prepare = vi.fn<(id: string, signal: AbortSignal) => Promise<void>>(async () => undefined), abandon = vi.fn(async () => undefined);
  let current = true;
  const handle = scopedSignInPreparation({ signal: host.signal, current: () => { if (!current) throw new Error("Revoked current mount"); }, prepare, abandon });
  await handle.prepare(new AbortController().signal); current = false; host.abort(); await flush();
  expect(abandon).toHaveBeenCalledOnce(); expect(() => handle.prepare(new AbortController().signal)).toThrow("Revoked");
  expect(prepare).toHaveBeenCalledOnce();
});

it("does not start another speculative mint when exact cancellation is unconfirmed", async () => {
  const host = new AbortController(), prepare = vi.fn<(id: string, signal: AbortSignal) => Promise<void>>(async () => undefined);
  const handle = scopedSignInPreparation({ signal: host.signal, current: () => undefined, prepare,
    abandon: async () => { throw new Error("cancel unconfirmed"); } });
  await handle.prepare(new AbortController().signal);
  await expect(handle.abandon()).rejects.toThrow("cancel unconfirmed");
  await expect(handle.prepare(new AbortController().signal)).rejects.toThrow("cancel unconfirmed");
  expect(prepare).toHaveBeenCalledOnce();
});

it("keeps advisory failure out of ordinary consent/start and does not prepare from an inactive setup", async () => {
  const prepare = vi.fn(() => { throw new Error("optional native hook unavailable"); }), abandon = vi.fn(async () => undefined);
  let current = false;
  const setup = setupSignInPreparation({ prepare, abandon }, () => current);
  setup.ready(); await flush(); expect(prepare).not.toHaveBeenCalled(); current = true;
  setup.ready(); await flush(); expect(prepare).toHaveBeenCalledOnce();
  setup.handoff(new AbortController().signal); setup.close(); await flush();
  expect(prepare).toHaveBeenCalledTimes(2); expect(abandon).not.toHaveBeenCalled();
});

it("invalidates configuration/background before another readiness event, with no timer-based renewals", async () => {
  const prepare = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => undefined), abandon = vi.fn(async () => undefined);
  const setup = setupSignInPreparation({ prepare, abandon }, () => true);
  setup.ready(); await flush(); const before = prepare.mock.calls[0]![0];
  setup.invalidate(); expect(before.aborted).toBe(true); setup.ready(); await flush();
  expect(prepare).toHaveBeenCalledTimes(2); expect(prepare.mock.calls[1]![0]).not.toBe(before);
  setup.close(); setup.ready(); await flush(); expect(prepare).toHaveBeenCalledTimes(2);
});

it("fences queued readiness after close, background, configuration change or consent handoff", async () => {
  for (const transition of ["close", "background", "config", "handoff"] as const) {
    const prepare = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => undefined), abandon = vi.fn(async () => undefined);
    let current = true;
    const setup = setupSignInPreparation({ prepare, abandon }, () => current);
    setup.ready();
    if (transition === "close") setup.close();
    if (transition === "background") { current = false; setup.invalidate(); }
    if (transition === "config") { setup.invalidate(); setup.ready(); }
    if (transition === "handoff") { setup.handoff(new AbortController().signal); setup.close(); }
    await flush();
    expect(prepare).toHaveBeenCalledTimes(transition === "config" || transition === "handoff" ? 1 : 0);
    if (prepare.mock.calls.length) expect(prepare.mock.calls[0]![0].aborted).toBe(false);
  }
});

it("fences queued consent handoff when its fresh action or current mount is revoked", async () => {
  for (const transition of ["abort", "revoke"] as const) {
    const prepare = vi.fn<(signal: AbortSignal) => Promise<void>>(async () => undefined), abandon = vi.fn(async () => undefined);
    let current = true;
    const setup = setupSignInPreparation({ prepare, abandon }, () => current), action = new AbortController();
    setup.handoff(action.signal);
    if (transition === "abort") action.abort(); else current = false;
    setup.close(); await flush(); expect(prepare).not.toHaveBeenCalled();
  }
});

it("handing off preserves the setup flight through metadata close and binds cancellation to the fresh action", async () => {
  const host = new AbortController(), prepare = vi.fn<(id: string, signal: AbortSignal) => Promise<void>>(async () => undefined), abandon = vi.fn(async () => undefined);
  const handle = scopedSignInPreparation({ signal: host.signal, current: () => undefined, prepare, abandon });
  const setup = setupSignInPreparation(handle, () => true), action = new AbortController();
  setup.ready(); await flush(); const original = prepare.mock.calls[0]![0];
  setup.handoff(action.signal); setup.close(); await flush();
  expect(prepare.mock.calls.every(([id]) => id === original)).toBe(true); expect(abandon).not.toHaveBeenCalled();
  action.abort(); await flush(); expect(abandon).toHaveBeenCalledWith(original);
});

it("supports legacy hosts without any speculative call, consent or capture operation", () => {
  const setup = setupSignInPreparation(undefined, () => true);
  setup.ready(); setup.invalidate(); setup.handoff(new AbortController().signal); setup.close();
});
