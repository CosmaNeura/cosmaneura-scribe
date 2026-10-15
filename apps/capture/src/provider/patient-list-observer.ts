interface Options<T> {
  active(): boolean;
  visible(): boolean;
  pending(): boolean;
  read(signal: AbortSignal): Promise<T>;
  apply(value: T): void;
  unavailable(): void;
}

/** Patient browsing refreshes quietly; a wire request retains its slot until settled. */
export class PatientListObserver<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading: AbortController | null = null;
  private closed = false;
  private generation = 0;
  constructor(private readonly options: Options<T>) {}
  schedule(immediate = false): void {
    clearTimeout(this.timer);
    if (this.closed || this.reading || !this.options.active() || !this.options.visible()) return;
    this.timer = setTimeout(() => { void this.check(); }, immediate ? 0 : this.options.pending() ? 3000 : 30_000);
  }
  pause(): void { clearTimeout(this.timer); this.generation += 1; this.reading?.abort(); }
  dispose(): void { this.closed = true; this.pause(); }
  private async check(): Promise<void> {
    if (this.closed || this.reading || !this.options.active() || !this.options.visible()) return;
    const generation = this.generation, controller = new AbortController(); this.reading = controller;
    const current = (): boolean => !this.closed && !controller.signal.aborted && generation === this.generation
      && this.options.active() && this.options.visible();
    const deadline = setTimeout(() => { if (current()) { this.options.unavailable(); controller.abort(); } }, 10_000);
    try { const result = await this.options.read(controller.signal); if (current()) this.options.apply(result); }
    catch { if (current()) this.options.unavailable(); }
    finally { clearTimeout(deadline); if (this.reading === controller) this.reading = null; this.schedule(); }
  }
}
