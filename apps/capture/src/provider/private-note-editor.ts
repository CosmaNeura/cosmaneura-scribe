import { LitElement, html } from "lit";
import type { PrivateNoteSession, PrivateNoteSnapshot } from "./private-note-session";

export class PrivateNoteEditor extends LitElement {
  static override properties = { port: { attribute: false }, mode: {}, expanded: { state: true }, snapshot: { state: true } };
  declare port: PrivateNoteSession | undefined;
  declare mode: "recording" | "note";
  declare private expanded: boolean;
  declare private snapshot: PrivateNoteSnapshot;
  private unsubscribe: (() => void) | undefined;
  constructor() { super(); this.mode = "recording"; this.expanded = false; this.snapshot = { text: "", status: "loading", updatedAt: null, editable: false }; }
  protected override createRenderRoot(): HTMLElement { return this; }
  override connectedCallback(): void {
    super.connectedCallback();
    if (this.port && !this.unsubscribe) this.unsubscribe = this.port.subscribe(value => { this.snapshot = value; });
  }
  protected override updated(changes: Map<string, unknown>): void {
    if (changes.has("port")) {
      this.unsubscribe?.(); this.unsubscribe = this.port?.subscribe(value => { this.snapshot = value; });
      if (this.mode === "note" || this.expanded) void this.port?.load();
    }
  }
  override disconnectedCallback(): void { this.unsubscribe?.(); this.unsubscribe = undefined; super.disconnectedCallback(); }
  protected override render() {
    if (!this.port) return html``;
    return html`<section class="provider-private-note" data-ph-no-capture data-sentry-block>
      ${!this.expanded && !this.snapshot.text ? html`<button class="provider-text-link" @click=${() => { this.expanded = true; void this.port?.load(); }}>Jot a note to yourself</button>` : html`
      <label>Your private note to self<textarea rows="3" maxlength="4000" .value=${this.snapshot.text}
        ?disabled=${!this.snapshot.editable}
        @input=${(event: Event) => { const area = event.target as HTMLTextAreaElement; const characters = [...area.value]; if (characters.length > 2000) area.value = characters.slice(0, 2000).join(""); void this.port?.change(area.value); }}></textarea></label>
      <p>Only you can see this. It stays separate from the clinical note and exports.</p>
      <p role="status">${this.snapshot.status === "saved" ? "Saved" : this.snapshot.status === "loading" ? "Loading…" : this.snapshot.status === "saving" ? "Saving…" : this.snapshot.status === "conflict" ? "This private note changed on another device. Compare before saving." : "Save isn’t confirmed. Your retained edits are kept here."}</p>
      ${this.snapshot.status === "unconfirmed" ? html`<button class="provider-text-link" @click=${() => { void this.port?.retry(); }}>Try again</button>` : ""}
      ${this.snapshot.status === "conflict" ? html`<blockquote>${this.snapshot.remoteText}</blockquote><button @click=${() => { void this.port?.resolveConflict(false); }}>Use the saved note</button><button @click=${() => { void this.port?.resolveConflict(true); }}>Keep my edits</button>` : ""}`}
    </section>`;
  }
}

if (!customElements.get("scribe-private-note")) customElements.define("scribe-private-note", PrivateNoteEditor);
