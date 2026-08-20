import { LitElement, html, type TemplateResult } from "lit";

import { HttpCaptureBff } from "./bff/http-client";
import { BffCaptureQueueTransport } from "./bff/queue-transport";
import { HttpCiphertextUploadTarget } from "./bff/upload-target";
import {
  type CaptureSource,
} from "./capture";
import { createCaptureSource } from "./capture-source-factory";
import {
  CaptureFlowController,
  EncryptedIndexedDbFlowStore,
  acquireCaptureFlowLock,
  type CaptureFlowSnapshot,
  type ReleaseCaptureFlowLock,
} from "./flow";
import { CaptureQueue } from "./queue";
import { EncryptedIndexedDbQueueStorage } from "./storage";
import { bootstrapCapturePreview } from "./preview/bootstrap";

const SYNTHETIC_ENCOUNTER = Object.freeze({
  appointmentId: "synthetic-appointment",
  practitionerId: "synthetic-practitioner",
  patientId: "synthetic-patient",
  participantRegions: ["US-NY"],
});

class CaptureApp extends LitElement {
  #busy = false;
  #consented = false;
  #controller: CaptureFlowController | undefined;
  #sourceKind: CaptureSource["kind"] = "synthetic";
  #flowStore: EncryptedIndexedDbFlowStore | undefined;
  #queueStorage: EncryptedIndexedDbQueueStorage | undefined;
  #releaseCaptureFlowLock: ReleaseCaptureFlowLock | undefined;
  #snapshot: CaptureFlowSnapshot = {
    state: "idle",
    statusCode: "synthetic_preview_idle",
    sessionId: null,
    recordedChunks: 0,
    queuedChunks: 0,
    elapsedSeconds: 0,
    remainingBudgetSeconds: null,
    remainingAuthoritySeconds: null,
    transcriptionStatus: null,
    transcript: null,
  };
  #unsubscribe: (() => void) | undefined;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  public override disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#flowStore?.close();
    this.#queueStorage?.close();
    void this.#releaseCaptureFlowLock?.();
    this.#releaseCaptureFlowLock = undefined;
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    void this.#run(async () => {
      await bootstrapCapturePreview();
      this.#releaseCaptureFlowLock = await acquireCaptureFlowLock();
      const controller = await this.#getController();
      const restored = await controller.restore();
      if (
        restored &&
        (controller.snapshot.state === "uploading" ||
          controller.snapshot.state === "processing")
      ) {
        await controller.resumePendingWork();
      }
    });
  }

  protected override render(): TemplateResult {
    return html`
      <div class="shell">
        <header>
          <span class="brand">Cosmaneura Capture</span>
          <span class="status" data-testid="synthetic-only">
            ${this.#sourceKind === "microphone"
              ? "Synthetic data · Microphone test"
              : "Synthetic data · Silent source"}
          </span>
        </header>
        <main>
          <p class="eyebrow">Phase 3 foreground flow</p>
          <h1>Consented recording, safely staged</h1>
          <p class="intro">
            ${this.#sourceKind === "microphone"
              ? "This preview uses synthetic identifiers with an explicitly enabled foreground microphone test adapter."
              : "This preview uses synthetic identifiers and a silent generated source; microphone access is disabled by default."}
            It never connects to a patient, Scribe, Azure Speech, or a clinical tenant.
          </p>

          <section class="flow-card" aria-labelledby="consent-title">
            <div>
              <p class="step">Step 1</p>
              <h2 id="consent-title">Confirm consent</h2>
              <p>
                All parties must consent. The visit is recorded and transcribed into draft clinical
                documentation. Recording can be stopped at any time.
              </p>
            </div>
            <label class="consent-control">
              <input
                data-testid="consent-checkbox"
                type="checkbox"
                .checked=${this.#consented}
                ?disabled=${this.#snapshot.state !== "idle" || this.#busy}
                @change=${this.#onConsentChange}
              />
              <span>All parties have consented to this synthetic preview.</span>
            </label>
            <button
              data-testid="begin-session"
              class="primary"
              ?disabled=${!this.#consented || this.#snapshot.state !== "idle" || this.#busy}
              @click=${this.#prepare}
            >
              Prepare secure session
            </button>
          </section>

          <section class="flow-card recorder" aria-labelledby="record-title">
            <div>
              <p class="step">Step 2</p>
              <h2 id="record-title">Record</h2>
              <p>
                ${this.#sourceKind === "microphone"
                  ? "The foreground microphone test adapter is explicitly enabled for synthetic test data."
                  : "Microphone capture is disabled; the button emits valid silent WAV chunks."}
                The initial server-authorized recording window is fixed and is not renewed in this
                preview.
              </p>
            </div>
            <div class="record-actions">
              <button
                data-testid="record-button"
                class="record-button"
                aria-label=${this.#sourceKind === "microphone"
                  ? "Start foreground microphone test recording"
                  : "Start silent synthetic recording"}
                ?disabled=${this.#snapshot.state !== "ready" || this.#busy}
                @click=${this.#record}
              >
                <span aria-hidden="true"></span>
                Record
              </button>
              <button
                data-testid="stop-button"
                class="secondary"
                ?disabled=${!this.#canStop() || this.#busy}
                @click=${this.#stop}
              >
                Stop and upload
              </button>
            </div>
          </section>

          <section class="flow-card" aria-labelledby="status-title">
            <div>
              <p class="step">Step 3</p>
              <h2 id="status-title">Status</h2>
            </div>
            <dl>
              <dt>Flow</dt>
              <dd data-testid="flow-status">${displayFlowState(this.#snapshot.state)}</dd>
              <dt>Recorded chunks</dt>
              <dd>${this.#snapshot.recordedChunks}</dd>
              <dt>Elapsed</dt>
              <dd>${formatDuration(this.#snapshot.elapsedSeconds)}</dd>
              <dt>Remaining server budget</dt>
              <dd data-testid="remaining-budget">
                ${this.#snapshot.remainingBudgetSeconds === null
                  ? "not loaded"
                  : formatDuration(this.#snapshot.remainingBudgetSeconds)}
              </dd>
              <dt>Current authorized recording window</dt>
              <dd data-testid="authority-window">
                ${this.#snapshot.remainingAuthoritySeconds === null
                  ? "not loaded"
                  : formatDuration(this.#snapshot.remainingAuthoritySeconds)}
              </dd>
              <dt>Reserved queue window</dt>
              <dd data-testid="queue-status">${queueStatus(this.#snapshot)}</dd>
              <dt>Transcription</dt>
              <dd data-testid="transcript-status">
                ${displayTranscriptionStatus(this.#snapshot)}
              </dd>
            </dl>
            ${this.#snapshot.remainingBudgetSeconds !== null &&
            this.#snapshot.remainingBudgetSeconds <= 300
              ? html`<p class="budget-warning">Recording budget is nearly exhausted.</p>`
              : ""}
            ${this.#snapshot.remainingAuthoritySeconds !== null &&
            this.#snapshot.remainingAuthoritySeconds <= 300
              ? html`<p class="budget-warning">
                  The current recording authorization window expires soon. Stop and upload before
                  it closes.
                </p>`
              : ""}
            ${this.#snapshot.state === "processing"
              ? html`
                  <button
                    data-testid="refresh-status"
                    class="secondary"
                    ?disabled=${this.#busy}
                    @click=${this.#refreshStatus}
                  >
                    Refresh synthetic status
                  </button>
                `
              : ""}
            ${this.#renderTranscript()}
          </section>

          <p class="fixed-status" role="status">${this.#snapshot.statusCode}</p>
        </main>
      </div>
    `;
  }

  #renderTranscript(): TemplateResult | string {
    const transcript = this.#snapshot.transcript;
    if (transcript === null) return "";
    return html`
      <div class="transcript" aria-label="Read-only synthetic transcript">
        <h3>Read-only transcript</h3>
        ${transcript.segments.map((segment) => html`
          <p><strong>${segment.speaker_role}</strong> ${segment.content}</p>
        `)}
      </div>
    `;
  }

  readonly #onConsentChange = (event: Event): void => {
    this.#consented = (event.currentTarget as HTMLInputElement).checked;
    this.requestUpdate();
  };

  readonly #prepare = (): void => {
    void this.#run(async () => {
      const controller = await this.#getController();
      await controller.prepare(SYNTHETIC_ENCOUNTER);
    });
  };

  readonly #record = (): void => {
    void this.#run(async () => this.#requireController().startRecording());
  };

  readonly #stop = (): void => {
    void this.#run(async () => this.#requireController().stopRecording());
  };

  readonly #refreshStatus = (): void => {
    void this.#run(async () => this.#requireController().refreshTranscriptionStatus());
  };

  async #getController(): Promise<CaptureFlowController> {
    if (this.#controller !== undefined) return this.#controller;
    const bff = new HttpCaptureBff();
    this.#queueStorage = await EncryptedIndexedDbQueueStorage.open();
    this.#flowStore = await EncryptedIndexedDbFlowStore.open();
    const queue = new CaptureQueue(this.#queueStorage);
    const source = await createCaptureSource();
    this.#sourceKind = source.kind;
    this.#controller = new CaptureFlowController({
      bff,
      flowStore: this.#flowStore,
      queue,
      queueTransport: new BffCaptureQueueTransport(
        bff,
        new HttpCiphertextUploadTarget([globalThis.location.origin]),
      ),
      source,
    });
    this.#unsubscribe = this.#controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.requestUpdate();
    });
    return this.#controller;
  }

  #requireController(): CaptureFlowController {
    if (this.#controller === undefined) throw new Error("capture flow is not prepared");
    return this.#controller;
  }

  async #run(operation: () => Promise<void>): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.requestUpdate();
    try {
      await operation();
    } catch {
      // The controller exposes fixed metadata-only status codes. Raw failures stay suppressed.
      if (this.#snapshot.state === "idle") {
        this.#snapshot = {
          ...this.#snapshot,
          state: "error",
          statusCode: "synthetic_preview_failed",
        };
      }
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  #canStop(): boolean {
    return this.#snapshot.state === "recording" || this.#snapshot.state === "paused";
  }
}

customElements.define("cosmaneura-capture", CaptureApp);

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

function queueStatus(snapshot: CaptureFlowSnapshot): string {
  if (snapshot.state === "uploading") return `${String(snapshot.recordedChunks)} uploading`;
  if (snapshot.state === "processing" || snapshot.state === "complete") return "0 pending";
  return `${String(snapshot.recordedChunks)} encrypted · ${String(snapshot.queuedChunks)} reserved`;
}

function displayFlowState(state: CaptureFlowSnapshot["state"]): string {
  return state === "complete" ? "ready" : state;
}

function displayTranscriptionStatus(snapshot: CaptureFlowSnapshot): string {
  const status = snapshot.transcriptionStatus?.status;
  if (status === undefined) return "not requested";
  return status === "completed" ? "ready" : status;
}
