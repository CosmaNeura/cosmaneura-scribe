import { LitElement, html } from "lit";

import {
  PROTOCOL_VERSION,
  TARGET_CHUNK_DURATION_SECONDS,
} from "@cosmaneura-scribe/capture-protocol";

class CaptureApp extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override render() {
    return html`
      <div class="shell">
        <header>
          <span class="brand">Cosmaneura Capture</span>
          <span class="status">Not activated</span>
        </header>
        <main>
          <h1>Secure capture foundation</h1>
          <p>
            The shared web, iOS, and Android shell is installed. Recording remains unavailable until
            the consent, key-custody, and native-audio work is completed and accepted.
          </p>
          <dl aria-label="Protocol details">
            <dt>Capture protocol</dt>
            <dd>v${PROTOCOL_VERSION}</dd>
            <dt>Target chunk duration</dt>
            <dd>${TARGET_CHUNK_DURATION_SECONDS} seconds</dd>
          </dl>
        </main>
      </div>
    `;
  }
}

customElements.define("cosmaneura-capture", CaptureApp);
