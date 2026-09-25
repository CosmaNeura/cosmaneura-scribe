import { LitElement, css, html } from "lit";
import { IOSPCM } from "./capacitor-pcm";
import { parseInputSignal, presentInputSignal, type IosInputSignal } from "./ios-input-signal";

/** Mounted only while the native iPhone view reports recording. Never requests microphone access. */
export class IosInputMeter extends LitElement {
  static override styles = css`
    :host { display: block; margin: 1rem 0; }
    .bars { display: flex; align-items: end; gap: 4px; height: 32px; margin: .5rem 0; }
    .bar { width: 7px; border-radius: 3px; background: #d5ddd9; }
    .on { background: #167052; }
    p { margin: .4rem 0; font-size: .9rem; }
  `;
  #signal: IosInputSignal | null = null;
  #receivedAt = -Infinity;
  #generation = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.#generation += 1;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), 250);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#generation += 1;
    clearInterval(this.#timer); this.#timer = undefined;
    this.#pending = false; this.#signal = null; this.#receivedAt = -Infinity;
  }

  #tick(): void {
    this.requestUpdate(); // Expire a stale level even if the bridge request never settles.
    if (this.#pending) return;
    this.#pending = true;
    const generation = this.#generation;
    void this.#read(generation);
  }

  async #read(generation: number): Promise<void> {
    try {
      const value = await IOSPCM.getCaptureSignal?.();
      if (generation !== this.#generation || !this.isConnected) return;
      this.#signal = parseInputSignal(value);
      this.#receivedAt = performance.now();
    } catch {
      if (generation === this.#generation) { this.#signal = null; this.#receivedAt = -Infinity; }
    } finally {
      if (generation === this.#generation) { this.#pending = false; this.requestUpdate(); }
    }
  }

  protected override render() {
    const state = presentInputSignal(this.#signal, performance.now() - this.#receivedAt);
    const bars = Math.ceil(state.level * 12);
    return html`<strong>${state.route}</strong>
      <div class="bars" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow=${Math.round(state.level * 100)}>
        ${Array.from({ length: 12 }, (_, i) => html`<span aria-hidden="true"
          class=${i < bars ? "bar on" : "bar"} style=${`height:${8 + i * 2}px`}></span>`)}
      </div><p role="status">${state.message}</p>`;
  }
}

if (!customElements.get("scribe-ios-input-meter")) customElements.define("scribe-ios-input-meter", IosInputMeter);
