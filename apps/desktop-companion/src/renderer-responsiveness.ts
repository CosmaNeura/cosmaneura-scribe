/** A main-issued, constant no-op proves only that the renderer can respond.
 * It never accepts renderer claims about visibility, identity, or capture. */
export class RendererResponsiveness {
  private pending = false;
  private generation = 0;
  private freshUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly probe: () => Promise<unknown>,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  invalidate(): void {
    this.generation += 1;
    this.freshUntil = Number.NEGATIVE_INFINITY;
  }

  isResponsive(): boolean {
    const now = this.clock();
    if (!this.pending) {
      this.pending = true;
      const generation = this.generation;
      const deadline = now + 1000;
      void Promise.resolve().then(this.probe).then(() => {
        // A late reply cannot resurrect a lease, including after Stop/close.
        if (generation === this.generation && this.clock() < deadline) {
          this.freshUntil = now + 1500;
        }
      }, () => {
        if (generation === this.generation) this.invalidate();
      }).finally(() => { this.pending = false; });
    }
    return now < this.freshUntil;
  }
}
