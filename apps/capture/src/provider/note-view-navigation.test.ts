import { afterEach, expect, it, vi } from "vitest";
import { noteConversationView } from "./note-view";
import { scrollNoteSourceMatch } from "./note-source-navigation";

// DOM-position fixture: real navigation and memory-only selection helpers run.
// Browser layout is checked separately; this fixture does not claim viewport geometry.
class Node {
  readonly dataset: Record<string, string> = {};
  readonly children = new Map<string, Node>();
  readonly attributes = new Map<string, string>();
  parentElement: Node | null = null;
  isConnected = true;
  hidden = false;
  open = false;
  textContent = "";
  scrollTop = 0;
  scrollLeft = 0;
  scrollIntoView = vi.fn();
  contains(node: Node): boolean { for (let at: Node | null = node; at; at = at.parentElement) if (at === this) return true; return false; }
  querySelector(selector: string): Node | null { return this.children.get(selector) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  focus(): void { setActive(this); }
}
class TextArea extends Node {
  value = "Synthetic unsaved reminder";
  defaultValue = "Synthetic saved reminder";
  selectionStart = 7;
  selectionEnd = 14;
  selectionDirection = "backward";
  readOnly = false;
  setSelectionRange(start: number, end: number, direction: string): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
}
let active: Node | null = null;
const setActive = (node: Node): void => { active = node; };
afterEach(() => { vi.unstubAllGlobals(); });
function fixture(desktop = false) {
  const note = new Node(), editor = new Node(), privateEditor = new Node(), clinical = new TextArea(), privateField = new TextArea();
  editor.parentElement = note; privateEditor.parentElement = note; clinical.parentElement = editor; privateField.parentElement = privateEditor;
  const evidence = new Node(), back = new Node(), search = new Node(), details = new Node(), toggle = new Node();
  evidence.parentElement = note; back.parentElement = evidence; search.parentElement = evidence; toggle.parentElement = note;
  note.children.set(".provider-note-evidence", evidence);
  note.children.set('[data-workspace-action="transcript-view"]', toggle);
  evidence.children.set("[data-note-back]", back); evidence.children.set("input, summary", search); evidence.children.set("details", details);
  note.dataset.conversation = "hidden"; evidence.hidden = true;
  const page = { scrollX: 12, scrollY: 710, matchMedia: () => ({ matches: desktop }), getComputedStyle: () => ({ overflowY: "visible" }), scrollTo: vi.fn((x: number, y: number) => { page.scrollX = x; page.scrollY = y; }) };
  vi.stubGlobal("HTMLTextAreaElement", TextArea);
  vi.stubGlobal("document", { get activeElement() { return active; } });
  vi.stubGlobal("window", page);
  return { note, editor, privateEditor, clinical, privateField, evidence, back, search, toggle, details, page,
    show: (field: TextArea | null) => noteConversationView(note as unknown as HTMLElement, true, field as unknown as HTMLTextAreaElement, null) };
}

it.each(["clinical", "privateField"] as const)("returns to the same mounted %s editor with unsaved text, selection, scroll and recovery lock intact", fieldName => {
  const f = fixture(), field = f[fieldName], parent = field.parentElement!;
  field.scrollTop = 23; parent.scrollTop = 41; parent.scrollLeft = 5;
  // Clicking Conversation moves focus to its button; the last editor still has its caret.
  active = f.toggle;
  const position = f.show(field);
  expect(f.note.dataset.noteView).toBe("transcript"); expect(f.evidence.hidden).toBe(false);
  expect(f.note.scrollIntoView).toHaveBeenCalledOnce(); expect(active).toBe(f.back); expect(f.details.open).toBe(true);
  expect(position?.field).toBe(field); expect(position?.pageY).toBe(710);
  field.readOnly = true; // An uncertain clinical save must remain locked on return.
  field.scrollTop = 0; parent.scrollTop = 0; f.page.scrollY = 100;
  const repeated = noteConversationView(f.note as unknown as HTMLElement, true, f.clinical as unknown as HTMLTextAreaElement, position);
  expect(repeated).toBe(position); // A source shortcut or save cannot replace the original return point.
  expect(noteConversationView(f.note as unknown as HTMLElement, false, null, repeated)).toBeNull();
  expect(f.note.dataset.noteView).toBe("note"); expect(f.evidence.hidden).toBe(true); expect(active).toBe(field);
  expect(field.value).toBe("Synthetic unsaved reminder"); expect(field.defaultValue).toBe("Synthetic saved reminder");
  expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([7, 14, "backward"]);
  expect(field.scrollTop).toBe(23); expect(parent.scrollTop).toBe(41); expect(parent.scrollLeft).toBe(5);
  expect(f.page.scrollTo).toHaveBeenLastCalledWith(12, 710); expect(field.readOnly).toBe(true);
  expect(field.parentElement).toBe(parent); expect(parent.parentElement).toBe(f.note);
});

it("keeps desktop conversation beside the mounted note without scrolling to a mobile return control", () => {
  const f = fixture(true); active = f.clinical;
  const position = f.show(f.clinical);
  expect(f.note.dataset.conversation).toBe("shown"); expect(f.evidence.hidden).toBe(false);
  expect(f.note.scrollIntoView).not.toHaveBeenCalled(); expect(active).toBe(f.search);
  expect(f.toggle.textContent).toBe("Hide the conversation"); expect(f.toggle.attributes.get("aria-expanded")).toBe("true");
  noteConversationView(f.note as unknown as HTMLElement, false, null, position);
  expect(active).toBe(f.clinical); expect(f.toggle.attributes.get("aria-expanded")).toBe("false");
});

it("does not restore a field from another visit and returns keyboard focus to the visible Conversation button", () => {
  const f = fixture(), other = new TextArea(); active = other;
  const position = f.show(other);
  expect(position?.field).toBeNull();
  noteConversationView(f.note as unknown as HTMLElement, false, null, position);
  expect(active).toBe(f.toggle); expect(f.page.scrollTo).toHaveBeenLastCalledWith(12, 710);
});

it("restores the private editor's original caret and page after a late transcript match scrolls mobile page flow", () => {
  const f = fixture(); active = f.privateField;
  f.privateField.scrollTop = 23;
  const position = f.show(f.privateField);
  const pane = { clientHeight: 6400, scrollHeight: 6400, closest: () => null };
  const row = { scrollIntoView: vi.fn(() => { f.page.scrollY = 5450; }) };
  scrollNoteSourceMatch(pane as unknown as HTMLElement, row as unknown as HTMLElement);
  expect(f.page.scrollY).toBe(5450);
  noteConversationView(f.note as unknown as HTMLElement, false, null, position);
  expect(f.page.scrollY).toBe(710); expect(active).toBe(f.privateField); expect(f.privateField.scrollTop).toBe(23);
  expect([f.privateField.selectionStart, f.privateField.selectionEnd, f.privateField.selectionDirection]).toEqual([7, 14, "backward"]);
});
