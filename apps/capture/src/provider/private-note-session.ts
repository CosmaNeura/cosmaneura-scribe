import { NoteAutosave } from "./note-autosave";
import { privateText, type PrivateNote } from "./visit-features";

export interface PrivateNoteLocal {
  readonly text: string;
  readonly confirmedText: string;
  readonly version: number;
  readonly pending: { readonly text: string; readonly expectedVersion: number; readonly key: string } | null;
}
export interface PrivateNoteSnapshot {
  readonly text: string;
  readonly status: "loading" | "saved" | "saving" | "unconfirmed" | "conflict";
  readonly updatedAt: string | null;
  readonly editable: boolean;
  readonly remoteText?: string;
}
interface Options {
  active(): boolean;
  local(): PrivateNoteLocal | null;
  retain(value: PrivateNoteLocal): Promise<void>;
  read(): Promise<PrivateNote>;
  save(text: string, expectedVersion: number, key: string): Promise<PrivateNote>;
}

/** Author reminder owner; this text never enters clinical note fields or sources. */
export class PrivateNoteSession {
  private value: PrivateNoteLocal = { text: "", confirmedText: "", version: 0, pending: null };
  private status: PrivateNoteSnapshot["status"] = "loading";
  private updatedAt: string | null = null;
  private remote: PrivateNote | null = null;
  private closed = false;
  private retentionUnconfirmed = false;
  private initialized = false;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<(value: PrivateNoteSnapshot) => void>();
  private readonly autosave: NoteAutosave;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly options: Options) {
    this.autosave = new NoteAutosave({ active: () => this.active() && this.initialized && this.status !== "conflict", dirty: () => this.retentionUnconfirmed || this.value.pending !== null || this.value.text !== this.value.confirmedText,
      save: () => this.saveOne(), failed: () => { this.status = "unconfirmed"; this.emit(); } });
  }
  getSnapshot(): PrivateNoteSnapshot { return { text: this.value.text, status: this.status, updatedAt: this.updatedAt, editable: this.initialized && this.status !== "conflict", ...(this.remote ? { remoteText: this.remote.text } : {}) }; }
  subscribe(listener: (value: PrivateNoteSnapshot) => void): () => void { this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
  load(): Promise<void> {
    return this.loading ??= (async () => {
      this.status = "loading"; this.emit();
      const local = this.options.local(); if (local) this.value = structuredClone(local);
      try {
        const remote = await this.options.read(); if (!this.active()) return;
        this.initialized = true; this.updatedAt = remote.updatedAt;
        if (local?.pending) this.status = "unconfirmed";
        else if (local && local.text !== local.confirmedText && local.version !== remote.version) { this.remote = remote; this.status = "conflict"; }
        else {
          this.value = { text: local && local.text !== local.confirmedText ? local.text : remote.text,
            confirmedText: remote.text, version: remote.version, pending: null };
          this.status = this.value.text === remote.text ? "saved" : "saving";
          if (this.status === "saving") this.autosave.changed();
        }
      } catch { if (this.active()) this.status = "unconfirmed"; }
      this.emit();
    })();
  }
  async change(text: string): Promise<void> {
    if (!privateText(text) || !this.active() || !this.initialized || this.status === "loading" || this.status === "conflict") return;
    this.value = { ...this.value, text }; this.status = "saving"; this.emit();
    try { await this.retain(); if (this.active()) this.autosave.changed(); }
    catch { this.status = "unconfirmed"; this.emit(); }
  }
  async retry(): Promise<boolean> {
    if (!this.initialized) { this.loading = null; await this.load(); if (!this.initialized) return false; }
    return this.autosave.flush();
  }
  async keepLocal(): Promise<boolean> {
    if (this.status === "loading") return true;
    try { await this.retain(); return true; } catch { this.status = "unconfirmed"; this.emit(); return false; }
  }
  async resolveConflict(keepEdits: boolean): Promise<void> {
    if (!this.remote || !this.active()) return;
    const remote = this.remote; this.remote = null;
    this.value = { text: keepEdits ? this.value.text : remote.text, confirmedText: remote.text, version: remote.version, pending: null };
    this.status = "saving"; this.emit();
    try {
      await this.retain(); if (!this.active()) return;
      this.status = keepEdits ? "saving" : "saved"; this.emit();
      if (keepEdits) this.autosave.changed();
    } catch { this.status = "unconfirmed"; this.emit(); }
  }
  private active(): boolean { return !this.closed && this.options.active(); }
  dispose(): void { this.closed = true; this.autosave.dispose(); this.listeners.clear(); }
  private retain(): Promise<void> {
    const snapshot = structuredClone(this.value);
    const writing = this.writes.then(() => { if (!this.active()) throw new Error("Private note unavailable"); return this.options.retain(snapshot); });
    const retained = writing.then(() => { this.retentionUnconfirmed = false; }, error => { this.retentionUnconfirmed = true; throw error; });
    this.writes = retained.catch(() => undefined); return retained;
  }
  private async saveOne(): Promise<boolean> {
    // Clear an acknowledged/compared request durably before assigning a new
    // key. The encrypted journal deliberately forbids replacing pending keys.
    if (this.retentionUnconfirmed) await this.retain();
    if (!this.value.pending && this.value.text === this.value.confirmedText) { await this.retain(); this.status = "saved"; this.emit(); return true; }
    const pending = this.value.pending ?? { text: this.value.text, expectedVersion: this.value.version, key: crypto.randomUUID() };
    this.value = { ...this.value, pending }; this.status = "saving"; this.emit();
    await this.retain();
    try {
      const saved = await this.options.save(pending.text, pending.expectedVersion, pending.key);
      if (!this.active()) return false;
      if (saved.text !== pending.text || saved.version < pending.expectedVersion + 1) throw new Error("Private note confirmation unavailable");
      this.value = { ...this.value, confirmedText: saved.text, version: saved.version, pending: null };
      this.updatedAt = saved.updatedAt; await this.retain();
      this.status = this.value.text === saved.text ? "saved" : "saving"; this.emit(); return true;
    } catch (error) {
      if (this.active()) {
        // A changed author version requires an explicit comparison, not an overwrite.
        try { const remote = await this.options.read(); if (remote.version > pending.expectedVersion && remote.text !== pending.text) { this.remote = remote; this.status = "conflict"; this.emit(); return false; } }
        catch { /* The exact encrypted request remains available for Retry. */ }
      }
      throw error;
    }
  }
  private emit(): void { if (this.active()) for (const listener of this.listeners) listener(this.getSnapshot()); }
}
