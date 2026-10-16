import { expect, it } from "vitest";
import { noteView } from "./note-view";
import type { CoreDraft } from "./core-notes";

it("keeps template order, exposes one dashboard action, and escapes patient and note text", () => {
  const value = { note_type: "Example", field_order: ["Plan", "Subjective"], fields: { Plan: "<script>bad</script>", Subjective: "Example" }, reviewed_source: {} } as unknown as CoreDraft;
  const view = noteView(value, "<patient>", "<p>Authorized conversation</p>");
  expect(view.indexOf("<label>Plan")).toBeLessThan(view.indexOf("<label>Subjective"));
  expect(view).toContain("&lt;patient&gt;"); expect(view).toContain("&lt;script&gt;bad&lt;/script&gt;");
  expect(view).toContain('data-workspace-action="finish-note">Save and review');
  expect(view).not.toContain('data-workspace-action="save"');
  expect(view).toContain('class="provider-note-evidence" hidden');
});
