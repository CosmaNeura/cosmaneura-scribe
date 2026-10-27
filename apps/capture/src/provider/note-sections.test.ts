import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { noteSectionGroups, noteSections } from "./note-sections";
import { pendingSave, type CoreDraft } from "./core-notes";

it("prioritizes SOAP while keeping every unknown clinical heading discoverable", () => {
  const keys = ["MRN/DOB", "Patient goals", "P - PLAN", "Medications", "Chief complaint", "S - SUBJECTIVE", "O - OBJECTIVE", "A - ASSESSMENT", "Payer"];
  const original = [...keys];
  expect(noteSectionGroups(keys)).toEqual({ main: ["S - SUBJECTIVE", "O - OBJECTIVE", "A - ASSESSMENT", "P - PLAN"],
    additional: ["Chief complaint", "Patient goals", "Medications"], details: ["MRN/DOB", "Payer"] });
  expect(keys).toEqual(original);
});

it("opens up to four custom clinical sections when a template is not SOAP", () => {
  expect(noteSectionGroups(["Goals", "Barriers", "Skills", "Practice", "Next session"])).toEqual({
    main: ["Goals", "Barriers", "Skills", "Practice"], additional: ["Next session"], details: [],
  });
});

it("retains all 100 fields, original indices, ordered save hash and existing lineage when most sections are collapsed", () => {
  const keys = ["MRN", "Plan", "Subjective", "Objective", "Assessment", ...Array.from({ length: 95 }, (_, i) => `Custom section ${i}`)];
  const fields = Object.fromEntries(keys.map((key, i) => [key, `Synthetic retained text ${i}\nSecond line.`]));
  const noteHash = createHash("sha256").update(JSON.stringify(keys.map(key => [key, fields[key]]))).digest("hex");
  const draft = { status: "draft", note_ref: "visit_note_synthetic", schema_ref: "doctor_note_schema_synthetic",
    source_sha256: "a".repeat(64), note_sha256: noteHash, reviewed_source: { working_version: 7 },
    fields, field_order: keys } as unknown as CoreDraft;
  const before = JSON.stringify(draft), html = noteSections(draft);
  expect(html.match(/<textarea data-note-field/gu)).toHaveLength(100);
  expect(html.match(/data-note-section="\d+" open/gu)).toHaveLength(4);
  expect(html).toContain("Additional note sections (95)"); expect(html).toContain("Visit details (1)");
  expect(html).toContain("Custom section 94"); expect(html).toContain("All text stays in your note and is saved.");
  for (const [index, key] of keys.entries()) expect(html).toContain(`name="note-${index}" aria-labelledby="note-section-${index}" rows="2">${fields[key]}`);
  expect(html).not.toMatch(/<textarea[^>]*(?:disabled|hidden)/u);
  const save = pendingSave(draft, { ...fields });
  expect(save.fieldOrder).toEqual(keys); expect(save.edit.fields).toEqual(fields);
  expect(save.edit.expected_note_sha256).toBe(noteHash); expect(save.edit.expected_source_sha256).toBe(draft.source_sha256);
  expect(createHash("sha256").update(JSON.stringify(save.fieldOrder.map(key => [key, save.edit.fields[key]]))).digest("hex")).toBe(noteHash);
  expect(JSON.stringify(draft)).toBe(before);
});

it("escapes unknown section headings and content in both picker and editor", () => {
  const html = noteSections({ field_order: ['Custom <script>"heading"'], fields: { 'Custom <script>"heading"': "<script>alert('synthetic')</script>" } } as unknown as CoreDraft);
  expect(html).not.toContain("<script>"); expect(html).toContain("Custom &lt;script&gt;");
  expect(html.match(/data-note-section-choice="0"/gu)).toHaveLength(1);
});
