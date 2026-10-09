import { LitElement, css, html } from "lit";
import type { DesktopInputFeedback } from "../provider-binding";

export function desktopInputLevel(value: { level: number; ageMs: number } | null | undefined, responseAgeMs: number): {
  level: number; label: string; available: boolean;
} {
  if (!value || responseAgeMs > 1_500 || value.ageMs + responseAgeMs > 1_500) {
    return { level: 0, label: "Checking input", available: false };
  }
  const level = value.level > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(value.level) + 60) / 60)) : 0;
  return { level, label: level > 0 ? "Sound detected" : "No sound detected", available: true };
}

/** Numeric activity from the authenticated main process, never generated bars.
 * A view-side clock expires a frozen IPC snapshot without waiting for another reply. */
export class DesktopInputMeter extends LitElement {
  static override styles = css`
    :host { display: block; min-width: 0; }
    .inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .input { display: grid; gap: 3px; min-width: 0; }
    strong { font-size: 12px; color: #12372d; }
    span, p { font-size: 11px; color: #536860; }
    meter { width: 100%; height: 12px; accent-color: #167052; }
    p { margin: 6px 0 0; line-height: 1.4; }
  `;
  static override properties = { microphoneOnly: { type: Boolean } };
  declare microphoneOnly: boolean;
  constructor() {
    super();
    this.microphoneOnly = false;
  }
  #signal: DesktopInputFeedback | undefined;
  #receivedAt = -Infinity;
  #timer: ReturnType<typeof setInterval> | undefined;
  set signal(value: DesktopInputFeedback | undefined) {
    if (value === this.#signal) return;
    this.#signal = value; this.#receivedAt = performance.now(); this.requestUpdate();
  }
  override connectedCallback(): void {
    super.connectedCallback(); this.#timer = setInterval(() => this.requestUpdate(), 250);
  }
  override disconnectedCallback(): void {
    clearInterval(this.#timer); this.#timer = undefined;
    this.#signal = undefined; this.#receivedAt = -Infinity; super.disconnectedCallback();
  }
  protected override render() {
    const age = performance.now() - this.#receivedAt;
    const microphone = desktopInputLevel(this.#signal?.microphone, age);
    const meeting = desktopInputLevel(this.#signal?.meetingAudio, age);
    return html`<div class="inputs" aria-label="Audio input activity">
      ${(this.microphoneOnly ? [["Microphone", microphone]] : [["Microphone", microphone], ["Application audio", meeting]]).map(([name, value]) => {
        const state = value as ReturnType<typeof desktopInputLevel>;
        return html`<div class="input"><strong>${name}</strong><meter min="0" max="100"
          value=${Math.round(state.level * 100)} aria-label=${name}></meter><span>${state.label}</span></div>`;
      })}
    </div>${microphone.level === 0 || !this.microphoneOnly && meeting.level === 0
      ? html`<p>${this.microphoneOnly ? "Say a few words and check that both voices move the microphone bar." : "Check Microphone when you speak and Application audio when the other participant speaks."}</p>` : ""}`;
  }
}
if (!customElements.get("scribe-desktop-input-meter")) customElements.define("scribe-desktop-input-meter", DesktopInputMeter);
