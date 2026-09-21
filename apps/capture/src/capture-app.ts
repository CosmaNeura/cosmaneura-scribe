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
import { HttpCreatorReviewApi } from "../../review-ui/src/creator-review-api";
import { mountCreatorReview } from "../../review-ui/src/creator-review-panel";
import { isUuid } from "../../review-ui/src/contracts";
import type { ProviderCaptureBinding } from "./provider-binding";

const SYNTHETIC_ENCOUNTER = Object.freeze({
  appointmentId: "synthetic-appointment",
  practitionerId: "synthetic-practitioner",
  patientId: "synthetic-patient",
  participantRegions: ["US-NY"],
});

export class CaptureApp extends LitElement {
  #provider: ProviderCaptureBinding | undefined;
  #providerClosed = false;
  #providerCloseStatus: "closing" | "closed" | "unconfirmed" = "closing";
  #disposeReview: (() => void) | undefined;
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

  /** Bind once, before mounting. Default preview startup never supplies this. */
  public bindProvider(binding: ProviderCaptureBinding): void {
    if (this.isConnected || this.#provider || this.#providerClosed || !isUuid(binding.sessionId)
      || binding.signal.aborted || binding.controller.snapshot.sessionId !== binding.sessionId) {
      throw new Error("Provider recording is unavailable.");
    }
    this.#provider = binding;
    this.#controller = binding.controller;
    this.#snapshot = binding.controller.snapshot;
    this.#sourceKind = binding.sourceKind;
    binding.signal.addEventListener("abort", this.#closeProvider, { once: true });
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  public override disconnectedCallback(): void {
    if (this.#provider) this.#closeProvider();
    this.#unsubscribe?.();
    this.#flowStore?.close();
    this.#queueStorage?.close();
    void this.#releaseCaptureFlowLock?.();
    this.#releaseCaptureFlowLock = undefined;
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    if (this.#providerClosed) return;
    if (this.#provider) {
      this.#unsubscribe = this.#provider.controller.subscribe((snapshot) => {
        if (snapshot.sessionId !== this.#provider?.sessionId) { this.#closeProvider(); return; }
        this.#snapshot = snapshot;
        this.requestUpdate();
      });
      if (this.#providerClosed) this.#unsubscribe();
      this.#syncReview();
      return;
    }
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

  protected override updated(): void { this.#syncReview(); }

  #syncReview(): void {
    const binding = this.#provider;
    if (!binding || this.#providerClosed) return;
    const root = this.querySelector<HTMLElement>("[data-provider-review]");
    const available = ["processing", "complete"].includes(this.#snapshot.state);
    if (!available || root === null) {
      this.#disposeReview?.();
      this.#disposeReview = undefined;
    } else if (!this.#disposeReview) {
      this.#disposeReview = mountCreatorReview(root,
        new HttpCreatorReviewApi(binding.sessionId, binding.authorizedRequest), {
          journal: binding.journal,
          ...(binding.continueToNote ? { continueToNote: binding.continueToNote } : {}),
        });
    }
  }

  readonly #closeProvider = (): void => {
    if (this.#providerClosed) return;
    this.#providerClosed = true;
    this.#unsubscribe?.();
    this.#disposeReview?.();
    this.#disposeReview = undefined;
    const binding = this.#provider;
    this.#provider = undefined;
    this.#controller = undefined;
    binding?.signal.removeEventListener("abort", this.#closeProvider);
    // Clear protected DOM synchronously; late recorder/API replies cannot restore it.
    this.querySelector(".shell")?.setAttribute("hidden", "");
    this.#snapshot = { ...this.#snapshot, sessionId: null, transcript: null, transcriptionStatus: null };
    this.requestUpdate();
    if (binding) void Promise.resolve().then(() => binding.deactivate()).then(() => {
      this.#providerCloseStatus = "closed";
      this.requestUpdate();
    }, () => {
      this.#providerCloseStatus = "unconfirmed";
      this.requestUpdate();
    });
  };

  protected override render(): TemplateResult {
    if (this.#providerClosed) return html`<p role="status">${this.#providerCloseStatus === "closing"
      ? "Closing recording…"
      : this.#providerCloseStatus === "unconfirmed"
        ? "Recording stop could not be confirmed. Stop recording in the native app before continuing."
        : "Recording closed. Return to your authorized encounters to continue."}</p>`;
    const provider = this.#provider;
    const captureFinished = provider && ["processing", "complete"].includes(this.#snapshot.state);
    return html`
      <div class="shell">
        <header>
          <span class="brand">${provider ? "Cosmaneura Scribe" : "Cosmaneura Capture"}</span>
          <span class="status" data-testid=${provider ? "provider-recording" : "synthetic-only"}>
            ${provider ? "Your recording" : this.#sourceKind === "microphone"
              ? "Synthetic data · Microphone test"
              : "Synthetic data · Silent source"}
          </span>
        </header>
        <main>
          <p class="eyebrow">${provider ? "Record · Review · Prepare note" : "Phase 3 foreground flow"}</p>
          <h1>${captureFinished ? "Your encounter" : provider ? "Your encounter recording" : "Consented recording, safely staged"}</h1>
          <p class="intro">
            ${captureFinished ? "Recording uploaded. Review the transcript below before preparing your note."
              : provider ? "Record this consented encounter, then review its transcript before preparing your note."
              : this.#sourceKind === "microphone"
              ? "This preview uses synthetic identifiers with an explicitly enabled foreground microphone test adapter."
              : "This preview uses synthetic identifiers and a silent generated source; microphone access is disabled by default."}
            ${provider ? "" : "It never connects to a patient, Scribe, Azure Speech, or a clinical tenant."}
          </p>

          ${captureFinished ? html`<p>Recorded ${formatDuration(this.#snapshot.elapsedSeconds)}
            · ${provider.languageMode === "english_spanish" ? "English and Spanish" : "English"}</p>`
            : provider ? html`<section class="flow-card"><h2>Recording prepared</h2>
            <p>Encounter and consent confirmed through your workspace.</p>
            <p>${provider.languageMode === "english_spanish" ? "English and Spanish · Translate Spanish to English" : "English"}</p>
          </section>` : html`
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
          </section>`}

          ${captureFinished ? "" : html`<section class="flow-card recorder" aria-labelledby="record-title">
            <div>
              <p class="step">Step 2</p>
              <h2 id="record-title">Record</h2>
              <p>
                ${provider ? "Keep this app in the foreground while recording. Start and stop deliberately."
                  : this.#sourceKind === "microphone"
                  ? "The foreground microphone test adapter is explicitly enabled for synthetic test data."
                  : "Microphone capture is disabled; the button emits valid silent WAV chunks."}
                ${provider ? "" : "The initial server-authorized recording window is fixed and is not renewed in this preview."}
              </p>
            </div>
            <div class="record-actions">
              <button
                data-testid="record-button"
                class="record-button"
                aria-label=${provider ? "Start recording" : this.#sourceKind === "microphone"
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
          </section>`}

          ${provider ? (captureFinished ? "" : html`<section class="flow-card" aria-label="Recording progress">
            <p role="status">${this.#snapshot.state === "recording" ? "Recording"
              : this.#snapshot.state === "paused" ? "Recording interrupted — stopped"
              : this.#snapshot.state === "uploading" ? "Uploading your recording"
              : this.#snapshot.state === "error" ? "Recording needs recovery in your workspace" : "Ready to record"}</p>
            <p>Elapsed ${formatDuration(this.#snapshot.elapsedSeconds)}</p>
            ${this.#snapshot.remainingAuthoritySeconds === null ? "" : html`<p>
              Recording window remaining ${formatDuration(this.#snapshot.remainingAuthoritySeconds)}</p>`}
          </section>`) : html`<section class="flow-card" aria-labelledby="status-title">
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
            ${!provider && this.#snapshot.state === "processing"
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
            ${provider ? "" : this.#renderTranscript()}
          </section>`}

          ${provider ? html`<div data-provider-review></div>`
            : html`<p class="fixed-status" role="status">${this.#snapshot.statusCode}</p>`}
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
