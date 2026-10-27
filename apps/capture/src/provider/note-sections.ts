import type { CoreDraft } from "./core-notes";
import { noteFieldLabel, orderedNoteFields } from "./workspace-display";
import { escapeText } from "./visit-list-view";

/** Presentation only. Every field keeps its original key and form index. */
export function noteSectionGroups(keys: readonly string[]): { main: string[]; additional: string[]; details: string[] } {
  const { clinical, details } = orderedNoteFields(keys);
  const soap = clinical.filter(key => /^(?:subjective|hpi|history of present illness|objective|exam|physical exam|examination|assessment|plan)$/iu
    .test(key.trim().replace(/^[SOAP]\s*[-–—:]\s*/iu, "")));
  const main = (soap.length ? soap : clinical).slice(0, 4);
  return { main, additional: clinical.filter(key => !main.includes(key)), details };
}

export function noteSections(draft: CoreDraft): string {
  const keys = draft.field_order ?? [], groups = noteSectionGroups(keys);
  const field = (key: string, open = false): string => {
    const index = keys.indexOf(key), title = escapeText(noteFieldLabel(key));
    return `<details class="provider-note-section" data-note-section="${index}"${open ? " open" : ""}>
      <summary id="note-section-${index}">${title}</summary>
      <label><span class="provider-note-field-label">${title}</span><textarea data-note-field name="note-${index}" aria-labelledby="note-section-${index}" rows="2">${escapeText(draft.fields?.[key] ?? "")}</textarea></label></details>`;
  };
  const group = (label: string, fields: string[]): string => fields.length ?
    `<details class="provider-note-section-group" data-note-section-group><summary>${label} (${fields.length})</summary>
      <p class="provider-note-section-index">${fields.map(key => escapeText(noteFieldLabel(key))).join(" · ")}</p>
      ${fields.map(key => field(key)).join("")}</details>` : "";
  return `<details class="provider-note-section-picker"><summary>Choose expanded sections (${keys.length})</summary>
    <p>Collapse sections to shorten this view. All text stays in your note and is saved.</p>
    <div class="provider-note-section-choices">${keys.map((key, index) => `<label><input type="checkbox" data-note-section-choice="${index}"${groups.main.includes(key) ? " checked" : ""}>${escapeText(noteFieldLabel(key))}</label>`).join("")}</div>
    <div class="provider-note-section-buttons"><button type="button" data-note-sections="expand">Expand all</button><button type="button" data-note-sections="collapse">Collapse all</button></div></details>
    ${groups.main.map(key => field(key, true)).join("")}
    ${group("Additional note sections", groups.additional)}${group("Visit details", groups.details)}`;
}

/** Never unmount, disable or serialize an editor when changing its disclosure. */
export function bindNoteSections(root: HTMLElement): () => void {
  const sections = [...root.querySelectorAll<HTMLDetailsElement>("[data-note-section]")];
  const groups = [...root.querySelectorAll<HTMLDetailsElement>("[data-note-section-group]")];
  const choices = [...root.querySelectorAll<HTMLInputElement>("[data-note-section-choice]")];
  const size = (section: HTMLDetailsElement): void => {
    if (!section.open) return;
    for (const field of section.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")) {
      field.style.height = "auto"; field.style.height = `${Math.max(68, field.scrollHeight + 2)}px`;
    }
  };
  const sync = (): void => {
    for (const section of sections) {
      const choice = choices.find(input => input.dataset.noteSectionChoice === section.dataset.noteSection);
      if (choice) choice.checked = section.open;
      size(section);
    }
  };
  const change = (event: Event): void => {
    const choice = choices.find(input => input === event.target);
    if (!choice) return;
    const section = sections.find(item => item.dataset.noteSection === choice.dataset.noteSectionChoice);
    if (section) {
      section.open = choice.checked;
      if (choice.checked) { const group = section.closest<HTMLDetailsElement>("[data-note-section-group]"); if (group) group.open = true; }
      sync();
    }
  };
  const click = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-note-sections]") : null;
    if (!button || !root.contains(button)) return;
    const open = button.dataset.noteSections === "expand";
    for (const group of groups) group.open = open;
    for (const section of sections) section.open = open;
    sync();
  };
  for (const details of [...sections, ...groups]) details.addEventListener("toggle", sync);
  root.addEventListener("change", change); root.addEventListener("click", click); sync();
  return () => {
    for (const details of [...sections, ...groups]) details.removeEventListener("toggle", sync);
    root.removeEventListener("change", change); root.removeEventListener("click", click);
  };
}
