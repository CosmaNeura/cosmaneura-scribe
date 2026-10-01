import { LitElement, html, type TemplateResult } from "lit";
import { Capacitor } from "@capacitor/core";
import "./native/ios-input-meter";
import "./native/desktop-input-meter";
import { IOSPCM } from "./native/capacitor-pcm";
import { isMicrophoneInput, microphoneInputs, type MicrophoneInput } from "./native/microphone-input";

import { HttpCaptureBff } from "./bff/http-client";
import { BffCaptureQueueTransport } from "./bff/queue-transport";
import { HttpCiphertextUploadTarget } from "./bff/upload-target";
import {
  type CaptureSource,
} from "./capture";
import { createCaptureSource } from "./capture-source-factory";
import { beginWorkflowTiming, type WorkflowTimingOutcome } from "./provider/workflow-timing";
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
import type { ProviderCaptureBinding, ProviderRecorderController, ProviderRecorderSnapshot } from "./provider-binding";

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
  #stopping = false;
  #cancelledStart = false;
  #showingChooser = false;
  #chooserUnavailable = false;
  #startupStartedAt: number | undefined;
  #startupTimer: ReturnType<typeof setInterval> | undefined;
  #startupSeconds = 0;
  #microphoneInput: MicrophoneInput = "built_in";
  #microphoneError = false;
  #consented = false;
  #controller: CaptureFlowController | undefined;
  #sourceKind: CaptureSource["kind"] = "synthetic";
  #flowStore: EncryptedIndexedDbFlowStore | undefined;
  #queueStorage: EncryptedIndexedDbQueueStorage | undefined;
  #releaseCaptureFlowLock: ReleaseCaptureFlowLock | undefined;
  #snapshot: ProviderRecorderSnapshot = {
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
    this.#snapshot = binding.controller.snapshot;
    this.#sourceKind = binding.sourceKind;
    binding.signal.addEventListener("abort", this.#closeProvider, { once: true });
  }

  /** Continue one explicit consent-screen Start, never a saved/replayed intent. */
  public async startFromProviderAction(input: MicrophoneInput): Promise<void> {
    if (!this.isConnected || !this.#provider || this.#providerClosed || this.#provider.signal.aborted
      || this.#snapshot.state !== "ready" || this.#snapshot.desktop && this.#snapshot.desktop.phase !== "ready"
      || !isMicrophoneInput(input)) return;
    this.#microphoneInput = input;
    await this.#record();
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  public override disconnectedCallback(): void {
    this.#clearStartupProgress();
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
      if (this.#providerClosed) { this.#unsubscribe(); return; }
      this.#syncReview();
      // Keep upload recovery in this view, including its busy guard and fixed
      // controller status, instead of failing the already-open encounter.
      if (this.#provider?.resumePendingUpload && this.#snapshot.state === "uploading"
        && (!this.#snapshot.desktop || this.#snapshot.desktop.phase === "stopped")) {
        void this.#run(async () => this.#provider!.resumePendingUpload!());
      }
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

  protected override updated(): void { this.#syncReview(); this.#syncStartupProgress(); }

  #isStarting(): boolean {
    return this.#snapshot.desktop?.phase === "starting" || this.#snapshot.native?.phase === "starting"
      || this.#snapshot.statusCode === "capture_starting" || this.#busy && this.#snapshot.state === "ready"
        && (!this.#snapshot.desktop || this.#snapshot.desktop.phase === "ready");
  }

  #clearStartupProgress(): void {
    clearInterval(this.#startupTimer); this.#startupTimer = undefined;
    this.#startupStartedAt = undefined; this.#startupSeconds = 0;
  }

  #syncStartupProgress(): void {
    if (!this.#provider || this.#providerClosed || !this.#isStarting() || this.#stopping) {
      this.#clearStartupProgress(); return;
    }
    if (this.#startupTimer !== undefined) return;
    this.#startupStartedAt = performance.now();
    this.#startupTimer = setInterval(() => {
      this.#startupSeconds = Math.floor((performance.now() - this.#startupStartedAt!) / 1000);
      this.requestUpdate();
    }, 1000);
  }

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
          ...(binding.speakerNameSuggestions ? { speakerNameSuggestions: binding.speakerNameSuggestions } : {}),
          ...(binding.editJournal ? { editJournal: binding.editJournal } : {}),
          ...(binding.continueToNote ? { continueToNote: binding.continueToNote } : {}),
          ...(binding.prepareNoteOpening ? { prepareNoteOpening: binding.prepareNoteOpening } : {}),
        });
    }
  }

  readonly #closeProvider = (): void => {
    if (this.#providerClosed) return;
    this.#providerClosed = true;
    this.#clearStartupProgress();
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
    const nativeProvider = provider?.captureMode === "native_microphone";
    const desktopProvider = provider?.captureMode === "desktop_meeting";
    const showInputMeter = this.#snapshot.state === "recording" && !this.#stopping
      && !this.#snapshot.desktop && this.#isNativeIPhone();
    return html`
      <div class=${nativeProvider ? "shell provider-native-capture" : desktopProvider
        ? `shell provider-desktop-capture${this.#isDesktopCompact() ? " provider-desktop-compact" : ""}` : "shell"}>
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
          <h1>${captureFinished ? "Your encounter" : nativeProvider || desktopProvider ? "Visit recording" : provider ? "Your encounter recording" : "Consented recording, safely staged"}</h1>
          <p class="intro" ?hidden=${(nativeProvider || desktopProvider) && !captureFinished}>
            ${captureFinished ? "Recording uploaded. Review the transcript below before preparing your note."
              : provider ? "Record this consented encounter, then review its transcript before preparing your note."
              : this.#sourceKind === "microphone"
              ? "This preview uses synthetic identifiers with an explicitly enabled foreground microphone test adapter."
              : "This preview uses synthetic identifiers and a silent generated source; microphone access is disabled by default."}
            ${provider ? "" : "It never connects to a patient, Scribe, Azure Speech, or a clinical tenant."}
          </p>

          ${captureFinished ? html`<p>${provider.languageMode === "english_spanish" ? "English and Spanish" : "English"}</p>`
            : provider ? html`<p>${provider.languageMode === "english_spanish" ? "English and Spanish · Translate Spanish to English" : "English"}</p>` : html`
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

          ${captureFinished ? "" : html`<section class="flow-card recorder" aria-label="Recording controls">
            <div ?hidden=${desktopProvider || nativeProvider}>
              ${provider ? "" : html`<p class="step">Step 2</p>`}
              <h2 id="record-title">${nativeProvider ? "Microphone" : "Record"}</h2>
              <p>
                ${provider?.captureMode === "desktop_meeting"
                  ? "Choose your Meet window in Chrome or your Zoom window when starting. This records your microphone and the selected application’s audio; other audio from that application may be included. Encrypted audio uploads while you record. If you go offline, saved audio waits on this Mac."
                  : nativeProvider ? "Audio is saved on this iPhone until upload is confirmed."
                  : provider ? "Keep this app in the foreground while recording. Start and stop deliberately."
                  : this.#sourceKind === "microphone"
                  ? "The foreground microphone test adapter is explicitly enabled for synthetic test data."
                  : "Microphone capture is disabled; the button emits valid silent WAV chunks."}
                ${provider ? "" : "The initial server-authorized recording window is fixed and is not renewed in this preview."}
              </p>
            </div>
            ${provider?.encounterLabel ? html`<div class="recording-patient" aria-label="Current visit">
              <strong>${provider.encounterLabel}</strong>
              <span>${provider.visitLabel ?? (desktopProvider ? "Video visit" : "In-person visit")}</span>
            </div>` : ""}
            ${desktopProvider || nativeProvider ? this.#renderProviderProgress() : ""}
            ${desktopProvider && this.#snapshot.desktop?.phase === "recording" && !this.#stopping
              ? html`<scribe-desktop-input-meter .signal=${this.#snapshot.desktop.inputSignal}></scribe-desktop-input-meter>` : ""}
            ${showInputMeter
              ? html`<scribe-ios-input-meter .readSignal=${provider?.controller.getCaptureSignal}></scribe-ios-input-meter>` : ""}
            ${this.#isNativeIPhone() && (!nativeProvider || ["ready", "paused"].includes(this.#snapshot.state)) ? html`<label>Microphone
              <select data-testid="microphone-input" .value=${this.#microphoneInput}
                ?disabled=${this.#busy || this.#stopping || !["ready", "paused"].includes(this.#snapshot.state)}
                @change=${this.#changeMicrophone}>
                ${microphoneInputs.map(input => html`<option value=${input.value}>${input.label}</option>`)}
              </select>
              <small>${microphoneInputs.find(input => input.value === this.#microphoneInput)?.help}</small>
            </label>` : ""}
            ${this.#microphoneError ? html`<p role="alert">Microphone choice could not be confirmed. Stop any other recording, then retry.</p>` : ""}
            <div class="record-actions">
              ${desktopProvider && this.#snapshot.statusCode === "capture_window_selection_pending"
                && provider.controller.showWindowChooser ? html`<button class="primary" data-testid="show-window-chooser"
                ?disabled=${this.#showingChooser || this.#stopping} @click=${this.#showWindowChooser}>${this.#showingChooser
                  ? "Showing chooser…" : "Show window chooser"}</button>` : ""}
              <button
                data-testid="record-button"
                class="record-button"
                ?hidden=${(nativeProvider || desktopProvider) && (this.#snapshot.state !== "ready" || this.#isStarting())}
                aria-label=${provider ? "Start recording" : this.#sourceKind === "microphone"
                  ? "Start foreground microphone test recording"
                  : "Start silent synthetic recording"}
                ?disabled=${this.#snapshot.state !== "ready" || this.#busy || this.#stopping
                  || this.#snapshot.desktop !== undefined && this.#snapshot.desktop.phase !== "ready"}
                @click=${this.#record}
              >
                <span aria-hidden="true"></span>
                ${this.#busy && this.#snapshot.state === "ready" || this.#snapshot.statusCode === "capture_starting" ? "Starting…" : "Record"}
              </button>
              ${provider?.controller.pauseRecording && this.#snapshot.state === "recording"
                && (!this.#snapshot.desktop || this.#snapshot.desktop.phase === "recording") ? html`<button
                class="secondary" data-testid="pause-recording" ?disabled=${this.#busy || this.#stopping}
                @click=${this.#pause}>Pause</button>` : ""}
              ${provider?.controller.resumeRecording && this.#snapshot.state === "paused"
                && this.#snapshot.statusCode !== "capture_stop_acknowledgement_pending"
                && (!this.#snapshot.desktop || ["ready", "interrupted", "stopped"].includes(this.#snapshot.desktop.phase))
                && (!this.#snapshot.native || this.#snapshot.native.phase === "paused") ? html`<button
                class="primary" data-testid="resume-recording" ?disabled=${this.#busy || this.#stopping}
                @click=${this.#resume}>${this.#snapshot.statusCode === "capture_recovery_pending"
                  ? "Retry recovery and resume" : this.#isCancelledEmptyStart() || this.#isExpiredEmptyStart()
                    ? "Start recording" : "Resume"}</button>` : ""}
              ${this.#isExpiredEmptyStart() ? html`<button class="secondary" data-testid="empty-setup-encounters"
                data-workspace-action="encounters" ?disabled=${this.#busy || this.#stopping}>Your encounters</button>` : ""}
              <button
                data-testid="stop-button"
                class="secondary"
                ?hidden=${(desktopProvider || nativeProvider) && (!this.#canStop() || this.#isCancelledEmptyStart()
                  || this.#isExpiredEmptyStart()) && !this.#stopping}
                ?disabled=${!this.#canStop() || this.#stopping || !this.#snapshot.desktop && !this.#snapshot.native && this.#busy}
                @click=${this.#stop}
              >
                ${this.#stopping ? this.#snapshot.native?.phase === "sealing" ? "Saving…"
                  : this.#uploadAfterStop() ? this.#snapshot.statusCode === "capture_upload_confirming" ? "Confirming upload…" : "Uploading…"
                  : this.#isStarting() ? "Cancelling start…" : "Stopping…"
                  : (this.#snapshot.desktop?.phase === "starting" || this.#snapshot.native?.phase === "starting") ? "Cancel start"
                  : this.#snapshot.statusCode === "capture_stop_acknowledgement_pending" ? "Retry confirmation and upload"
                  : this.#snapshot.statusCode === "capture_recovery_pending" ? "Retry saving and upload"
                  : this.#snapshot.desktop?.phase === "stop_unconfirmed" || this.#snapshot.statusCode === "audio_capture_native_stop_failed"
                  ? "Retry finish recording" : provider ? "Finish recording" : "Stop and upload"}
              </button>
              ${this.#snapshot.desktop?.phase === "permission_required" ? html`<button class="secondary"
                data-testid="refresh-permissions" ?disabled=${this.#busy} @click=${this.#refreshPermissions}>Set up recording access</button>` : ""}
              ${this.#canRetryUpload() ? html`<button class="primary" data-testid="retry-upload"
                ?disabled=${this.#busy || this.#stopping} @click=${this.#retryUpload}>Retry upload</button>` : ""}
            </div>
            ${this.#chooserUnavailable && this.#snapshot.statusCode === "capture_window_selection_pending"
              ? html`<p class="recording-recovery" role="alert">The chooser is still opening or could not come forward. Try Show window chooser again, or Cancel start.</p>` : ""}
            ${desktopProvider ? html`<details class="recording-source-help">
              <summary>Microphone + meeting audio</summary>
              <p>Choose your Zoom window or Meet window in Chrome. Scribe records your microphone and the selected application’s audio; other audio from that application may be included.</p>
              <p>Encrypted audio uploads while you record. If you go offline, saved audio waits on this Mac.</p>
            </details>` : nativeProvider ? html`<details class="recording-source-help">
              <summary>Microphone and saved audio</summary>
              <p>Audio is saved on this iPhone until upload is confirmed.</p>
            </details>` : ""}
          </section>`}

          ${provider ? (captureFinished || desktopProvider || nativeProvider ? "" : this.#renderProviderProgress()) : html`<section class="flow-card" aria-labelledby="status-title">
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
                  The current recording authorization window expires soon. Finish recording before
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

          ${provider && this.#snapshot.desktop ? html`<details data-testid="desktop-coverage"
            ?open=${this.#snapshot.desktop.coverage === "incomplete"}>
            <summary>${this.#snapshot.desktop.coverage === "incomplete" ? "Check recording coverage" : "Recording details"}</summary>
            <p role="status">
            ${this.#snapshot.desktop.coverage === "incomplete"
              ? "Recording coverage is incomplete. Review the retained audio and transcript for missing speech."
              : this.#snapshot.desktop.coverage === "aligned" ? "Microphone and meeting audio are aligned."
              : this.#snapshot.desktop.coverage === "complete" ? "Recording retained the interval covered by both microphone and meeting audio."
              : this.#snapshot.desktop.phase === "starting" ? "Recording is not confirmed yet."
              : ["stopping", "stop_unconfirmed", "interrupted"].includes(this.#snapshot.desktop.phase)
                ? "Recording status is being confirmed."
              : this.#snapshot.desktop.phase === "stopped" ? "No complete recording interval is confirmed."
              : "Recording has not started."}
            ${this.#snapshot.desktop.trimmedStartMs > 0 ? ` The first ${this.#snapshot.desktop.trimmedStartMs} ms before both sources were available was excluded.` : ""}
            ${(this.#snapshot.desktop.trimmedEndMs ?? 0) > 0 ? ` The final ${this.#snapshot.desktop.trimmedEndMs} ms without both sources was excluded.` : ""}
          </p></details>` : ""}

          ${provider ? html`<div data-provider-review></div>`
            : html`<p class="fixed-status" role="status">${this.#snapshot.statusCode}</p>`}
        </main>
      </div>
    `;
  }

  #isDesktopCompact(): boolean {
    const phase = this.#snapshot.desktop?.phase;
    return this.#provider?.captureMode === "desktop_meeting" && phase !== undefined
      && (["starting", "recording", "stopping", "stop_unconfirmed"].includes(phase)
        || this.#snapshot.state === "paused" && phase === "interrupted");
  }

  #isCancelledEmptyStart(): boolean {
    // A confirmed native pause plus an empty initial attempt is distinct from
    // pausing a visit. The retry uses the same retained recorder, not a new one.
    return this.#cancelledStart && this.#snapshot.state === "paused"
      && this.#snapshot.statusCode === "capture_paused" && this.#snapshot.recordedChunks === 0
      && this.#snapshot.queuedChunks === 0 && this.#snapshot.elapsedSeconds === 0
      && (this.#snapshot.native?.phase === "paused" || this.#snapshot.desktop?.phase === "ready"
        && this.#snapshot.desktop.coverage === "not_started");
  }

  #isExpiredEmptyStart(): boolean {
    // This status is issued only after confirmed physical stop with no capture
    // coverage/history. queuedChunks can include unused reserved slots, not audio.
    return this.#provider?.captureMode === "desktop_meeting" && this.#snapshot.state === "paused"
      && this.#snapshot.statusCode === "capture_setup_expired" && this.#snapshot.recordedChunks === 0
      && this.#snapshot.elapsedSeconds === 0 && this.#snapshot.desktop?.phase === "interrupted"
      && this.#snapshot.desktop.coverage === "not_started";
  }

  #uploadAfterStop(): boolean {
    // Native sealed means physical stop plus durable completion intent. Desktop
    // only enters this copy after its native stop and retained-flow transition.
    return this.#snapshot.native?.phase === "sealed" || this.#snapshot.desktop?.phase === "stopped"
      && (this.#snapshot.state === "uploading" || this.#snapshot.statusCode === "capture_upload_settling");
  }

  #renderProviderProgress(): TemplateResult {
    const desktopProvider = this.#provider?.captureMode === "desktop_meeting";
    const nativeProvider = this.#provider?.captureMode === "native_microphone";
    const showInputMeter = this.#snapshot.state === "recording" && !this.#stopping
      && !this.#snapshot.desktop && this.#isNativeIPhone();
    const uploadProgress = this.#snapshot.native?.uploadProgress ?? this.#snapshot.uploadProgress;
    return html`<section class=${desktopProvider || nativeProvider ? "recording-progress" : "flow-card"} aria-label="Recording progress">
            <p role="status" ?hidden=${nativeProvider && showInputMeter && this.#snapshot.statusCode === "capture_recording"}>${this.#stopping
              && this.#snapshot.native?.phase !== "sealing" && !this.#uploadAfterStop()
              ? this.#isStarting() ? "Cancelling start… Waiting for recording to stop." : "Stopping recording…"
              : !this.#snapshot.desktop && (this.#snapshot.statusCode === "capture_starting"
              || this.#busy && this.#snapshot.state === "ready") ? nativeProvider
                ? html`<strong>Starting microphone…</strong><span class="recording-state-detail">Recording is not confirmed yet.</span>`
                : "Starting microphone… Recording is not confirmed yet."
              : this.#snapshot.desktop?.phase === "starting"
              ? this.#snapshot.statusCode === "capture_window_selection_pending"
                ? "Choose your meeting window. Recording has not started."
                : "Starting microphone and meeting audio… Recording is not confirmed yet."
              : this.#snapshot.desktop?.phase === "stopping" ? this.#snapshot.statusCode === "capture_stop_acknowledgement_pending"
                ? "Confirming recording stopped…" : "Stopping recording…"
              : this.#snapshot.desktop?.phase === "stop_unconfirmed" ? "Recording may still be active. Choose Retry finish recording to confirm it has stopped."
              : this.#snapshot.statusCode === "capture_stop_acknowledgement_pending"
                ? "Recording has stopped. Retry confirmation before uploading."
              : this.#snapshot.desktop?.phase === "permission_required" ? "Choose Set up recording access to allow microphone and screen recording. If you previously denied access, enable Scribe in macOS Settings, then try again."
              : this.#snapshot.statusCode === "capture_stopping" ? "Stopping recording…"
              : this.#snapshot.statusCode === "capture_sealing" ? "Saving recording before upload…"
              : this.#snapshot.statusCode === "capture_start_failed" ? this.#snapshot.desktop
                ? "Recording did not start. Your saved audio is retained. Choose Start recording to try again."
                : "Recording could not start. Check your microphone and connection, then retry Resume."
              : this.#snapshot.statusCode === "capture_preparation_failed" ? "Recording preparation could not finish. Reopen this encounter to retry. Saved work is retained."
              : this.#snapshot.statusCode === "capture_setup_expired" ? this.#isExpiredEmptyStart()
                ? html`<strong>Recording has not started</strong><span class="recording-state-detail">Start recording when you’re ready. Your visit is still here.</span>`
                : "Recording setup expired. Confirm recording status before continuing."
              : this.#snapshot.statusCode === "capture_recovery_pending" ? "Recording is stopped, but saving could not be confirmed. Retry saving and upload, or verify the saved audio and resume recording."
              : this.#snapshot.statusCode === "capture_start_unconfirmed" ? "Recording start could not be confirmed. Stop confirmation is required before recording can resume."
              : this.#snapshot.statusCode === "capture_storage_low" ? "Not enough device storage to continue recording. Saved audio is retained. Free up space, then retry recording, or finish recording."
              : this.#snapshot.statusCode === "capture_storage_unavailable" ? "Device storage could not be checked. Saved audio is retained. Retry before continuing to record."
              : this.#snapshot.statusCode === "capture_tail_not_saved" ? "Recording has stopped, but the last part could not be saved. Earlier saved audio is retained. Keep this visit and contact support before continuing or uploading."
              : this.#snapshot.statusCode === "capture_interrupted" ? "Recording was interrupted. Saved audio is retained, but some audio just before the interruption may be missing. Speech during the interruption was not recorded. Check your microphone, then resume and repeat the last part, or finish recording."
              : this.#snapshot.statusCode === "capture_paused" ? this.#isDesktopCompact() || nativeProvider
                ? html`<strong>${this.#isCancelledEmptyStart() ? "Start canceled" : "Paused"}</strong><span class="recording-state-detail">${this.#isCancelledEmptyStart()
                  ? "Recording has not started. Start when ready." : "No audio is being recorded."}</span>`
                : "Recording is paused. Resume when ready, or finish recording. Missing speech during the pause cannot be recovered."
              : this.#snapshot.statusCode === "capture_no_saved_audio" ? "No audio was saved from this recording. Resume recording when ready."
              : this.#snapshot.statusCode === "capture_reopen_required" ? "Recording is stopped. Return to Your encounters and reopen this encounter to recover saved work."
              : this.#snapshot.statusCode === "capture_resume_pending" ? "Recording has not resumed. Check your connection and retry Resume. Saved audio is retained."
              : this.#snapshot.statusCode === "capture_upload_pending" ? "Recording has stopped. Your saved recording is waiting for upload confirmation. Check your connection and retry."
              : this.#snapshot.statusCode === "capture_upload_settling" ? "Recording stopped. Finishing the current upload…"
              : this.#snapshot.statusCode === "capture_upload_confirming" ? "Audio uploaded. Confirming receipt before transcription…"
              : this.#snapshot.state === "uploading" ? "Recording stopped. Uploading your saved audio…"
              : this.#snapshot.state === "error" ? "Recording needs recovery in your workspace"
              : this.#snapshot.desktop?.phase === "stopped" ? "Recording stopped"
              : this.#snapshot.desktop?.phase === "interrupted" ? "Recording interrupted. Confirm stop before uploading."
              : this.#snapshot.state === "recording" ? "Recording"
              : this.#snapshot.statusCode === "audio_capture_native_stop_failed"
                ? "Recording may still be active. Choose Retry finish recording to confirm it has stopped."
              : this.#snapshot.state === "paused" ? "Recording interrupted. Confirm stop before uploading."
              : "Ready to record"}</p>
            ${this.#isStarting() && !this.#stopping ? html`<p data-testid="startup-progress" aria-live="off">
              ${this.#snapshot.statusCode === "capture_window_selection_pending" ? "Waiting for window selection" : "Connecting"}
              · ${this.#startupSeconds}s. ${nativeProvider ? "Check the microphone feedback before continuing the visit."
                : "Wait for Recording and an advancing timer before speaking."}
              ${this.#startupSeconds >= 4 && this.#canStop() ? "Taking longer than expected. Choose Cancel start to stop waiting safely." : ""}
            </p>` : ""}
            ${uploadProgress && (this.#snapshot.state === "uploading" || this.#snapshot.statusCode === "capture_upload_settling") ? html`<label>
              Audio uploaded ${Math.floor(uploadProgress.registered * 100 / Math.max(1, uploadProgress.total))}%
              <progress aria-label="Audio upload" max=${uploadProgress.total || 1}
                value=${uploadProgress.registered}></progress>
            </label>` : ""}
            <p class="recording-duration"><span>${nativeProvider ? "Elapsed" : "Recorded"}</span> <strong>${formatDuration(this.#snapshot.elapsedSeconds)}</strong></p>
            ${desktopProvider && this.#snapshot.desktop?.phase === "recording" && !this.#stopping
              ? html`<p class="recording-control-hint">Use Pause for a break. Finish recording when the visit is finished.</p>` : ""}
            ${this.#snapshot.remainingAuthoritySeconds === null || this.#isExpiredEmptyStart() ? "" : html`<p
              ?hidden=${(this.#isDesktopCompact() || nativeProvider) && this.#snapshot.remainingAuthoritySeconds > 300}>
              Recording window remaining ${formatDuration(this.#snapshot.remainingAuthoritySeconds)}</p>`}
          </section>`;
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

  readonly #record = (): Promise<void> => {
    this.#cancelledStart = false; this.#chooserUnavailable = false;
    return this.#run(async () => {
      await this.#selectMicrophone();
      if (this.#providerClosed) return;
      await this.#requireController().startRecording();
    }, "record");
  };

  readonly #stop = (): void => {
    if (this.#snapshot.desktop || this.#snapshot.native) {
      if (this.#stopping) return;
      this.#cancelledStart = this.#isStarting();
      this.#stopping = true; this.requestUpdate();
      const finishTiming = beginWorkflowTiming("stop-upload");
      let outcome: WorkflowTimingOutcome = "resolved";
      // Startup can be cancelled even while its Start promise is pending.
      void this.#requireController().stopRecording().catch(() => { outcome = "threw"; }).finally(() => {
        this.#stopping = false; this.requestUpdate();
        finishTiming(this.#providerClosed ? "cancelled" : outcome);
      });
      return;
    }
    void this.#run(async () => this.#requireController().stopRecording(), "stop-upload");
  };

  readonly #showWindowChooser = (): void => {
    if (this.#showingChooser || this.#stopping || this.#snapshot.statusCode !== "capture_window_selection_pending") return;
    const controller = this.#provider?.controller;
    if (!controller?.showWindowChooser) return;
    this.#showingChooser = true; this.#chooserUnavailable = false; this.requestUpdate();
    // This must remain independent of the pending Start operation's busy guard.
    void controller.showWindowChooser().catch(() => { this.#chooserUnavailable = true; }).finally(() => {
      this.#showingChooser = false; this.requestUpdate();
    });
  };

  readonly #refreshPermissions = (): void => {
    void this.#run(async () => this.#requireController().refreshPermissions?.());
  };

  readonly #pause = (): void => { this.#cancelledStart = false; void this.#run(async () => this.#requireController().pauseRecording?.(), "pause"); };
  readonly #resume = (): void => { void this.#run(async () => {
    this.#cancelledStart = false;
    await this.#selectMicrophone();
    if (this.#providerClosed) return;
    await this.#requireController().resumeRecording?.();
  }, "resume"); };

  #isNativeIPhone(): boolean {
    return !this.#snapshot.desktop && this.#sourceKind === "microphone"
      && Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  }

  readonly #changeMicrophone = (event: Event): void => {
    if (this.#busy || this.#stopping || !["ready", "paused"].includes(this.#snapshot.state)) return;
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value !== "built_in" && value !== "bluetooth" && value !== "external") return;
    this.#microphoneInput = value; this.#microphoneError = false; this.requestUpdate();
  };

  async #selectMicrophone(): Promise<void> {
    if (!this.#isNativeIPhone()) return;
    this.#microphoneError = false;
    try {
      if (this.#provider?.controller.selectMicrophoneInput) {
        await this.#provider.controller.selectMicrophoneInput(this.#microphoneInput); return;
      }
      const result = await IOSPCM.selectMicrophoneInput?.({ input: this.#microphoneInput });
      if (!result || typeof result !== "object" || !("version" in result) || result.version !== 1
        || !("input" in result) || result.input !== this.#microphoneInput) throw new Error("Microphone unavailable");
    } catch {
      this.#microphoneError = true;
      throw new Error("Microphone unavailable");
    }
  }

  readonly #refreshStatus = (): void => {
    void this.#run(async () => this.#requireController().refreshTranscriptionStatus(), "transcript-refresh");
  };

  readonly #retryUpload = (): void => {
    if (!this.#canRetryUpload() || this.#stopping) return;
    void this.#run(async () => this.#provider!.resumePendingUpload!(), "upload-retry");
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

  #requireController(): ProviderRecorderController {
    if (this.#provider) return this.#provider.controller;
    if (this.#controller === undefined) throw new Error("capture flow is not prepared");
    return this.#controller;
  }

  async #run(operation: () => Promise<void>, timingAction?: string): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.requestUpdate();
    const finishTiming = beginWorkflowTiming(timingAction);
    let outcome: WorkflowTimingOutcome = "resolved";
    try {
      await operation();
    } catch {
      outcome = "threw";
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
      finishTiming(this.#providerClosed ? "cancelled" : outcome);
    }
  }

  #canStop(): boolean {
    if (this.#snapshot.native) return ["starting", "recording", "paused", "stopPending"].includes(this.#snapshot.native.phase);
    if (this.#snapshot.desktop) return ["starting", "recording", "interrupted", "stop_unconfirmed"].includes(this.#snapshot.desktop.phase);
    return this.#snapshot.state === "recording" || this.#snapshot.state === "paused";
  }

  #canRetryUpload(): boolean {
    return !!this.#provider?.resumePendingUpload && !this.#providerClosed && !this.#provider.signal.aborted
      && this.#snapshot.state === "uploading" && this.#snapshot.statusCode === "capture_upload_pending"
      && (!this.#snapshot.desktop || this.#snapshot.desktop.phase === "stopped");
  }
}

customElements.define("cosmaneura-capture", CaptureApp);

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (minutes >= 60) {
    return `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
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
