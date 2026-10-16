import { describe, expect, it, vi } from "vitest";
import { NoteAutosave } from "./note-autosave";

describe("note autosave", () => {
  it("coalesces typing and serializes an edit made while saving", async () => {
    vi.useFakeTimers(); let version = 1, saved = 0, complete!: () => void;
    const save = vi.fn(async () => { const sent = version; await new Promise<void>(resolve => { complete = resolve; }); saved = sent; return true; });
    const autosave = new NoteAutosave({ active: () => true, dirty: () => saved !== version, save, failed: vi.fn() });
    autosave.changed(); await vi.advanceTimersByTimeAsync(500); autosave.changed(); await vi.advanceTimersByTimeAsync(750);
    expect(save).toHaveBeenCalledTimes(1); version = 2; autosave.changed(); await vi.advanceTimersByTimeAsync(750);
    expect(save).toHaveBeenCalledTimes(1); complete(); await Promise.resolve(); await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2); const flushed = autosave.flush(); complete(); expect(await flushed).toBe(true);
    autosave.dispose(); vi.useRealTimers();
  });
  it("does not replay an unconfirmed save or write after disposal", async () => {
    const save = vi.fn(async () => false), failed = vi.fn();
    const autosave = new NoteAutosave({ active: () => true, dirty: () => true, save, failed });
    expect(await autosave.flush()).toBe(false); expect(save).toHaveBeenCalledTimes(1);
    autosave.dispose(); expect(await autosave.flush()).toBe(false); expect(save).toHaveBeenCalledTimes(1);
  });
});
