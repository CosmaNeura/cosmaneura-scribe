/** Memory-only editing position; never stored in journals, logs or network requests. */
export interface NoteEditorPosition {
  readonly field: HTMLTextAreaElement | null;
  readonly start: number | null;
  readonly end: number | null;
  readonly direction: "forward" | "backward" | "none" | null;
  readonly scroll: readonly { element: Element; top: number; left: number }[];
  readonly pageX: number;
  readonly pageY: number;
}

export function noteEditorPosition(root: HTMLElement, lastField: HTMLTextAreaElement | null): NoteEditorPosition {
  const focused = document.activeElement;
  const field = focused instanceof HTMLTextAreaElement && root.contains(focused) ? focused
    : lastField && root.contains(lastField) ? lastField : null;
  const scroll: { element: Element; top: number; left: number }[] = [];
  let element: Element | null = field ?? root;
  while (element) {
    scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
    element = element.parentElement;
  }
  return { field, start: field?.selectionStart ?? null, end: field?.selectionEnd ?? null,
    direction: field?.selectionDirection ?? null, scroll, pageX: window.scrollX, pageY: window.scrollY };
}

export function restoreNoteEditorPosition(position: NoteEditorPosition | null): void {
  if (!position) return;
  if (position.field?.isConnected) {
    position.field.focus({ preventScroll: true });
    if (position.start !== null && position.end !== null) {
      position.field.setSelectionRange(position.start, position.end, position.direction ?? undefined);
    }
  }
  for (const { element, top, left } of position.scroll) if (element.isConnected) {
    element.scrollTop = top; element.scrollLeft = left;
  }
  window.scrollTo(position.pageX, position.pageY);
}

export function setNoteEditorPending(root: HTMLElement, pending: boolean): void {
  for (const field of root.querySelectorAll<HTMLTextAreaElement>("textarea[data-note-field]")) field.readOnly = pending;
  const save = root.querySelector<HTMLButtonElement>('[data-workspace-action="save"]');
  if (save) save.disabled = pending;
}
