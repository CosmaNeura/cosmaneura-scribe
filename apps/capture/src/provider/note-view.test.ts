import { expect, it } from "vitest";
import { draftSaveState, noteView } from "./note-view";
import type { CoreDraft } from "./core-notes";

it("keeps template order, exposes one dashboard action, and escapes patient and note text", () => {
  const value = { note_type: "Example", field_order: ["Plan", "Subjective"], fields: { Plan: "<script>bad</script>", Subjective: "Example" }, reviewed_source: {} } as unknown as CoreDraft;
  const view = noteView(value, "<patient>", "<p>Authorized conversation</p>");
  expect(view.indexOf("<label>Plan")).toBeLessThan(view.indexOf("<label>Subjective"));
  expect(view).toContain("&lt;patient&gt;"); expect(view).toContain("&lt;script&gt;bad&lt;/script&gt;");
  expect(view).toContain('data-workspace-action="finish-note">Save and review');
  expect(view.match(/data-workspace-action="finish-note"/gu)).toHaveLength(1);
  expect(view.indexOf('data-workspace-action="finish-note"')).toBeLessThan(view.indexOf("<textarea"));
  expect(view).not.toContain('data-workspace-action="save"');
  expect(view).toContain('class="provider-note-evidence" hidden');
  expect(view).toContain('data-note-back data-workspace-action="note-view">Back to note');
  expect(view).toContain('class="provider-note-mobile-context">&lt;patient&gt;</p>');
  expect(view).toContain('data-note-save-state role="status" aria-atomic="true">Draft saved');
  expect(view).toContain("You’ll review and sign it in the CosmaNeura dashboard.");
});

it("distinguishes draft saving and failed or uncertain saves from acknowledged storage", () => {
  const acknowledged = { pending: false, dirty: false, unconfirmed: false, savedAt: null };
  expect(draftSaveState(acknowledged)).toBe("Draft saved");
  const savedAt = new Date("2026-10-16T10:15:00Z");
  expect(draftSaveState({ ...acknowledged, savedAt })).toBe(`Draft saved at ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  expect(draftSaveState({ ...acknowledged, dirty: true, savedAt })).toBe("Draft saving…");
  expect(draftSaveState({ ...acknowledged, pending: true })).toBe("Draft saving…");
  expect(draftSaveState({ ...acknowledged, dirty: true, unconfirmed: true })).toBe("Draft not saved");
  expect(draftSaveState({ ...acknowledged, pending: true, unconfirmed: true, savedAt })).toBe("Draft save not confirmed");
});
