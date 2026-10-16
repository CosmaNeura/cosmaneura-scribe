import { afterEach, expect, it, vi } from "vitest";
import { PrivateNoteSession, type PrivateNoteLocal } from "./private-note-session";
import type { PrivateNote } from "./visit-features";

afterEach(() => vi.useRealTimers());
const note = (text = "", version = 0): PrivateNote => ({ text, version, updatedAt: null });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };

it("keeps an unavailable first read disabled and retries the read before accepting edits", async () => {
  let reads = 0; const save = vi.fn(async text => note(text, 8));
  const session = new PrivateNoteSession({ active: () => true, local: () => null, retain: async () => {},
    read: async () => { if (!reads++) throw new Error("Offline"); return note("Previously saved reminder", 7); }, save });
  await session.load(); expect(session.getSnapshot()).toMatchObject({ status: "unconfirmed", editable: false });
  await session.change("Must not overwrite"); expect(save).not.toHaveBeenCalled();
  expect(await session.retry()).toBe(true); expect(reads).toBe(2);
  expect(session.getSnapshot()).toMatchObject({ status: "saved", text: "Previously saved reminder", editable: true }); session.dispose();
});

it("retains the exact private request before sending and saves newer typing against its confirmed version", async () => {
  let local: PrivateNoteLocal | null = null;
  const first = deferred<PrivateNote>(), calls: { text: string; version: number; key: string }[] = [];
  const session = new PrivateNoteSession({ active: () => true, local: () => local,
    retain: async value => { local = structuredClone(value); }, read: async () => note(),
    save: async (text, version, key) => {
      expect(local?.pending).toEqual({ text, expectedVersion: version, key });
      calls.push({ text, version, key }); return calls.length === 1 ? first.promise : note(text, version + 1);
    } });
  await session.load(); await session.change("Reminder one"); const saving = session.retry();
  await vi.waitFor(() => expect(calls).toHaveLength(1)); await session.change("Reminder two");
  first.resolve(note("Reminder one", 1)); expect(await saving).toBe(true);
  expect(calls.map(value => [value.text, value.version])).toEqual([["Reminder one", 0], ["Reminder two", 1]]);
  expect(calls[0]!.key).not.toBe(calls[1]!.key); expect(session.getSnapshot()).toMatchObject({ text: "Reminder two", status: "saved" }); session.dispose();
});

it("retries an ambiguous save with the retained key after a new session loads", async () => {
  let local: PrivateNoteLocal | null = null, key = "";
  const create = (fail: boolean) => new PrivateNoteSession({ active: () => true, local: () => local,
    retain: async value => { local = structuredClone(value); }, read: async () => note(),
    save: async (text, version, currentKey) => { if (fail) { key = currentKey; throw new Error("Offline"); } expect(currentKey).toBe(key); return note(text, version + 1); } });
  const first = create(true); await first.load(); await first.change("Private reminder"); expect(await first.retry()).toBe(false); first.dispose();
  const recovered = create(false); await recovered.load(); expect(recovered.getSnapshot().status).toBe("unconfirmed"); expect(await recovered.retry()).toBe(true);
  expect((local as PrivateNoteLocal | null)?.pending).toBeNull(); recovered.dispose();
});

it("requires an explicit comparison after a changed author version and fences late replies on disposal", async () => {
  let local: PrivateNoteLocal | null = null, reading = 0;
  const session = new PrivateNoteSession({ active: () => true, local: () => local, retain: async value => { local = value; },
    read: async () => note(reading++ ? "Saved on another device" : "", reading > 1 ? 1 : 0), save: async () => { throw new Error("Conflict"); } });
  await session.load(); await session.change("My edits"); expect(await session.retry()).toBe(false);
  expect(session.getSnapshot()).toMatchObject({ status: "conflict", text: "My edits", remoteText: "Saved on another device" });
  await session.resolveConflict(false); expect(session.getSnapshot()).toMatchObject({ status: "saved", text: "Saved on another device" });
  session.dispose(); await session.change("Late edit"); expect(session.getSnapshot().text).toBe("Saved on another device");
});

it("does not report a durable save while retaining its confirmation has failed", async () => {
  let writes = 0;
  const session = new PrivateNoteSession({ active: () => true, local: () => null, read: async () => note(),
    retain: async () => { writes++; if (writes === 3) throw new Error("Storage unavailable"); }, save: vi.fn(async text => note(text, 1)) });
  await session.load(); await session.change("Reminder"); expect(await session.retry()).toBe(false);
  expect(session.getSnapshot().status).toBe("unconfirmed"); expect(await session.retry()).toBe(true); expect(session.getSnapshot().status).toBe("saved"); session.dispose();
});

it("accepts the same acknowledged text at a newer author version without replaying forever", async () => {
  const session = new PrivateNoteSession({ active: () => true, local: () => null, read: async () => note(), retain: async () => {}, save: async text => note(text, 3) });
  await session.load(); await session.change("Same text on another device"); expect(await session.retry()).toBe(true);
  expect(session.getSnapshot()).toMatchObject({ status: "saved", text: "Same text on another device" }); session.dispose();
});
it.each([true, false])("shows unconfirmed after conflict retention fails (keep edits %s)", async keepEdits => {
  let fails = false, local: PrivateNoteLocal | null = { text: "My reminder", confirmedText: "", version: 0, pending: null };
  const session = new PrivateNoteSession({ active: () => true, local: () => local, read: async () => note("Other device", 1),
    retain: async value => { if (fails) throw new Error("Storage unavailable"); local = value; }, save: async text => note(text, 2) });
  await session.load(); expect(session.getSnapshot().status).toBe("conflict"); fails = true;
  await session.resolveConflict(keepEdits); expect(session.getSnapshot()).toMatchObject({ status: "unconfirmed", text: keepEdits ? "My reminder" : "Other device" });
  fails = false; expect(await session.retry()).toBe(true); expect(session.getSnapshot().status).toBe("saved"); session.dispose();
});
it("durably clears an acknowledged pending key before saving newer edits after a failed retain", async () => {
  let local: PrivateNoteLocal | null = null, failAcknowledgement = true;
  const first = deferred<PrivateNote>(), calls: string[] = [];
  const session = new PrivateNoteSession({ active: () => true, local: () => local, read: async () => note("A", 1),
    retain: async value => {
      if (local?.pending && value.pending && local.pending.key !== value.pending.key) throw new Error("Pending key is immutable");
      if (local?.pending && !value.pending && failAcknowledgement) { failAcknowledgement = false; throw new Error("Storage unavailable"); }
      local = structuredClone(value);
    }, save: async (text, version) => { calls.push(text); return calls.length === 1 ? first.promise : note(text, version + 1); } });
  await session.load(); await session.change("A edited"); const saving = session.retry();
  await vi.waitFor(() => expect(calls).toEqual(["A edited"])); await session.change("B edited");
  first.resolve(note("A edited", 2)); expect(await saving).toBe(false);
  expect(local!.pending?.text).toBe("A edited"); expect(session.getSnapshot().status).toBe("unconfirmed");
  expect(await session.retry()).toBe(true); expect(calls).toEqual(["A edited", "B edited"]);
  expect(local!.pending).toBeNull(); expect(local!.text).toBe("B edited"); session.dispose();
});
