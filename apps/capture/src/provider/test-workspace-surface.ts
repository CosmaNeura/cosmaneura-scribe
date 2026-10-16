import { vi } from "vitest";

/** A command/state fixture only. Browser integration covers actual DOM behavior. */
export class Surface extends EventTarget {
  private markup = "";
  readonly nodes = new Map<string, Surface>();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Set<string>();
  readonly classList = { add: vi.fn() };
  readonly style = { setProperty: vi.fn() };
  buttons: Surface[] = [];
  rows: Surface[] = [];
  parent: Surface | null = null;
  textContent = ""; hidden = false; disabled = false; isConnected = true;
  get innerHTML(): string { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value; this.nodes.clear(); this.buttons = []; this.rows = [];
    for (const match of value.matchAll(/\b(data-(?:workspace-content|workspace-notice|workspace-progress|workspace-navigation|provider-encounter|provider-account|provider-patient-detail|encounter-progress|note-readiness|note-wait-time|day-heading|day-label|day-today|day-empty))\b/gu)) this.nodes.set(`[${match[1]}]`, new Surface());
    for (const name of ["provider-header", "provider-note-options"]) if (value.includes(`class="${name}"`)) this.nodes.set(`.${name}`, new Surface());
    for (const match of value.matchAll(/<button\b([^>]*)>/gu)) {
      const action = /data-workspace-action="([^"]+)"/u.exec(match[1]!); if (!action) continue;
      const button = new Surface(); button.dataset.workspaceAction = action[1]!;
      const appointment = /data-appointment="([^"]+)"/u.exec(match[1]!); if (appointment) button.dataset.appointment = appointment[1]!;
      this.nodes.set(`[data-workspace-action="${action[1]}"]`, button); this.buttons.push(button);
    }
    if (value.includes('class="provider-encounters"')) {
      const list = new Surface(); this.nodes.set(".provider-encounters", list);
      for (const match of value.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gu)) {
        const row = new Surface(); row.innerHTML = match[2]!; row.parent = list;
        const ref = /data-visit-ref="([^"]+)"/u.exec(match[1]!); if (ref) row.dataset.visitRef = ref[1]!;
        for (const button of row.buttons) button.parent = row;
        list.rows.push(row); list.buttons.push(...row.buttons);
      }
    }
  }
  set outerHTML(value: string) { this.innerHTML = value.replace(/^<li[^>]*>|<\/li>$/gu, ""); }
  querySelector(selector: string): Surface | null { return this.nodes.get(selector) ?? null; }
  querySelectorAll(selector: string): Surface[] { return selector === "[data-visit-ref]" ? this.rows : selector === '[data-workspace-action="open"]' ? this.buttons.filter(button => button.dataset.workspaceAction === "open") : []; }
  contains(value: unknown): boolean { return value instanceof Surface && value.isConnected; }
  closest(selector: string): Surface | null { return selector === "li" ? this.parent : selector === "button[data-workspace-action]" ? this : null; }
  setAttribute(name: string): void { this.attributes.add(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getBoundingClientRect(): { height: number } { return { height: 0 }; }
  append(): void {}
  remove(): void { this.isConnected = false; }
  replaceChildren(): void { this.innerHTML = ""; }
  close(): void {}
}
