interface Options {
  active(): boolean;
  dirty(): boolean;
  save(): Promise<boolean>;
  failed(): void;
}

/** One save at a time; a newer edit waits for the acknowledged note version. */
export class NoteAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<boolean> | null = null;
  private closed = false;
  constructor(private readonly options: Options) {}
  changed(): void {
    clearTimeout(this.timer);
    if (!this.closed) this.timer = setTimeout(() => { void this.flush(); }, 750);
  }
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    const work = async (): Promise<boolean> => {
      try {
        while (!this.closed && this.options.active() && this.options.dirty()) {
          if (!await this.options.save()) return false;
        }
        return !this.closed && this.options.active();
      } catch { if (!this.closed && this.options.active()) this.options.failed(); return false; }
    };
    const result = work(); this.saving = result;
    void result.finally(() => { if (this.saving === result) this.saving = null; });
    return result;
  }
  dispose(): void { this.closed = true; clearTimeout(this.timer); }
}
