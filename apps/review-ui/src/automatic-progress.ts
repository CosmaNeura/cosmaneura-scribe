import type { CreatorReviewView } from "./creator-review-api";

/** Observation never starts/retries work or supplies a review decision. */
export function hasPendingReviewProgress(view: CreatorReviewView | null): boolean {
  if (!view) return false;
  if (view.source === null) return ["uploaded", "processing"].includes(view.status);
  if (view.status !== "translation_pending" || view.working?.note_ready) return false;
  if (view.working?.blockers.some(item => ["translation_retry_required", "translation_failed"].includes(item.code))) return false;
  return (view.translation_progress ?? []).some(item => ["queued", "result_saved"].includes(item.state));
}

/** Late observations cannot replace another session or an already newer transcript. */
export function canApplyReviewProgress(previous: CreatorReviewView | null, next: CreatorReviewView): boolean {
  if (!previous) return true;
  if (previous.session_id !== next.session_id) return false;
  if (previous.source && (!next.source || next.source.source_transcript_version < previous.source.source_transcript_version)) return false;
  return !(previous.working && next.working && previous.working.source_transcript_version === next.working.source_transcript_version
    && (previous.working.working_transcript_id !== next.working.working_transcript_id
      || next.working.working_transcript_version < previous.working.working_transcript_version));
}

export interface AutomaticProgressOptions<T> {
  readonly active: () => boolean;
  readonly pending: () => boolean;
  readonly visible: () => boolean;
  readonly read: (signal: AbortSignal) => Promise<T>;
  readonly apply: (value: T) => void;
  readonly stopped: (reason: "deadline" | "unavailable") => void;
}

/** One bounded, read-only observation loop owned by the displayed scope. */
export class AutomaticProgress<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private reading: AbortController | null = null;
  private closed = false;
  private halted = false;
  private haltReason: "deadline" | "unavailable" | null = null;
  private haltAnnounced = false;
  private generation = 0;
  private lastReadStarted: number | undefined;
  constructor(private readonly options: AutomaticProgressOptions<T>) {}

  schedule(immediate = false): void {
    clearTimeout(this.timer);
    if (this.closed || !this.options.active() || !this.options.pending() || !this.options.visible()) return;
    if (this.halted) { this.announceHalt(); return; }
    this.deadline ??= setTimeout(() => {
      this.halted = true; this.haltReason = "deadline"; this.pause(); this.announceHalt();
    }, 300_000);
    const delay = this.lastReadStarted === undefined ? 3000 : Math.max(0, 3000 - (performance.now() - this.lastReadStarted));
    if (!this.reading) this.timer = setTimeout(() => { void this.check(); }, immediate ? 0 : delay);
  }

  /** Explicit status checking can resume observation after its bounded stop. */
  restart(immediate = false): void {
    clearTimeout(this.deadline); this.deadline = undefined; this.halted = false; this.haltReason = null; this.haltAnnounced = false;
    this.lastReadStarted = undefined;
    this.schedule(immediate);
  }

  pause(): void {
    clearTimeout(this.timer); this.timer = undefined; this.generation += 1;
    this.reading?.abort();
  }

  dispose(): void {
    this.closed = true; this.pause(); clearTimeout(this.deadline);
  }

  private announceHalt(): void {
    if (!this.closed && !this.haltAnnounced && this.haltReason && this.options.active() && this.options.pending() && this.options.visible()) {
      this.haltAnnounced = true; this.options.stopped(this.haltReason);
    }
  }

  private async check(): Promise<void> {
    if (this.closed || this.halted || this.reading || !this.options.active() || !this.options.pending() || !this.options.visible()) return;
    const n = this.generation, controller = new AbortController(); this.reading = controller;
    this.lastReadStarted = performance.now();
    const current = (): boolean => !this.closed && !this.halted && !controller.signal.aborted
      && n === this.generation && this.options.active() && this.options.visible();
    const timeout = setTimeout(() => {
      if (current()) {
        this.halted = true; this.haltReason = "unavailable"; controller.abort(); this.announceHalt();
      }
    }, 30_000);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Progress observation cancelled"));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    // Aborting observation discards its response promptly, but does not prove
    // that an uncooperative read settled. Retain its slot until both settle so
    // showing the window or an explicit restart cannot overlap wire requests.
    let requestSettled = false, observationSettled = false;
    const release = (): void => {
      if (requestSettled && observationSettled && this.reading === controller) {
        this.reading = null; this.schedule();
      }
    };
    const request = new Promise<T>(resolve => { resolve(this.options.read(controller.signal)); });
    const settled = (): void => { requestSettled = true; release(); };
    void request.then(settled, settled);
    try {
      const value = await Promise.race([request, cancelled]);
      if (current()) this.options.apply(value);
    } catch {
      if (current()) { this.halted = true; this.haltReason = "unavailable"; this.announceHalt(); }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
      observationSettled = true; release();
    }
  }
}
