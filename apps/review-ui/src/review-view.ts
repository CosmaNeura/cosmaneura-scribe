import type { BetaIngest, BetaIngestStatus } from "./contracts";

export type LoadPhase = "error" | "idle" | "loading" | "ready";
export type CreatePhase = "error" | "idle" | "submitting" | "success";

export interface ReviewUiState {
  readonly tenantId: string | null;
  readonly ingests: readonly BetaIngest[];
  readonly listPhase: LoadPhase;
  readonly selectedId: string | null;
  readonly selectedIngest: BetaIngest | null;
  readonly previewPhase: LoadPhase;
  readonly createPhase: CreatePhase;
  readonly includeTranscript: boolean;
  readonly notice: string | null;
}

export function renderReviewView(state: ReviewUiState): string {
  return `
    <div class="site-shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="Cosmaneura Scribe Beta home">
          <span class="brand-mark" aria-hidden="true">C</span>
          <span>Cosmaneura <strong>Scribe</strong></span>
        </a>
        <span class="environment-pill"><span aria-hidden="true"></span> Synthetic · local only</span>
      </header>

      <main>
        <section class="hero" aria-labelledby="page-title">
          <div>
            <p class="eyebrow">Founder preview</p>
            <h1 id="page-title">A calm place to review every word.</h1>
            <p class="hero-copy">
              Create a synthetic ingest, confirm it persisted, and read the transcript in one
              local workspace. Nothing here connects to a patient or production.
            </p>
          </div>
          <div class="hero-proof" aria-label="Local Beta safeguards">
            <span><i aria-hidden="true">01</i> Synthetic fixture</span>
            <span><i aria-hidden="true">02</i> Process-local store</span>
            <span><i aria-hidden="true">03</i> No cloud services</span>
          </div>
        </section>

        ${state.tenantId === null ? renderTenantGate() : renderWorkspace(state)}
      </main>

      <footer>
        <span>Scribe Beta · local review surface</span>
        <span>No audio · no PHI · no publish</span>
      </footer>
    </div>
  `;
}

function renderTenantGate(): string {
  return `
    <section class="gate-card" data-testid="tenant-missing" aria-labelledby="tenant-gate-title">
      <div class="gate-icon" aria-hidden="true">×</div>
      <p class="eyebrow">Requests locked</p>
      <h2 id="tenant-gate-title">The synthetic tenant fixture is missing.</h2>
      <p>
        Start the complete local Beta launcher. The review UI will not list, create, or load a
        session without the launcher's fixed tenant context.
      </p>
    </section>
  `;
}

function renderWorkspace(state: ReviewUiState): string {
  return `
    <section class="workspace" aria-label="Scribe Beta review workspace">
      <aside class="session-rail">
        ${renderCreateForm(state)}
        ${renderSessionList(state)}
      </aside>
      <section class="review-pane" aria-live="polite">
        ${renderPreview(state)}
      </section>
    </section>
  `;
}

function renderCreateForm(state: ReviewUiState): string {
  const submitting = state.createPhase === "submitting";
  const notice = state.notice === null
    ? ""
    : `<p class="form-notice ${state.createPhase === "error" ? "error" : ""}" role="status">${escapeHtml(state.notice)}</p>`;
  return `
    <section class="create-card" aria-labelledby="new-ingest-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">New review</p>
          <h2 id="new-ingest-title">Create an ingest</h2>
        </div>
        <span class="plus-mark" aria-hidden="true">+</span>
      </div>
      <p class="supporting-copy">
        Uses fixed synthetic dialogue only. No names, notes, or audio can be entered.
      </p>
      <form data-action="create">
        <label class="check-row">
          <input
            type="checkbox"
            name="include-transcript"
            ${state.includeTranscript ? "checked" : ""}
            ${submitting ? "disabled" : ""}
          />
          <span>
            <strong>Include sample transcript</strong>
            <small>Turn off to preview the processing state.</small>
          </span>
        </label>
        <button class="primary-button" data-testid="create-ingest" type="submit" ${submitting ? "disabled" : ""}>
          <span>${submitting ? "Saving locally…" : "Create synthetic ingest"}</span>
          <span aria-hidden="true">→</span>
        </button>
      </form>
      ${notice}
    </section>
  `;
}

function renderSessionList(state: ReviewUiState): string {
  const refreshDisabled = state.listPhase === "loading" ? "disabled" : "";
  let content: string;
  if (state.listPhase === "loading" || state.listPhase === "idle") {
    content = `
      <div class="list-message" data-testid="sessions-loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <p><strong>Loading local sessions</strong><small>Checking the in-process store…</small></p>
      </div>`;
  } else if (state.listPhase === "error") {
    content = `
      <div class="list-message" data-testid="sessions-error">
        <span class="message-glyph" aria-hidden="true">!</span>
        <p><strong>Sessions are unavailable</strong><small>The local host did not return a safe response.</small></p>
        <button class="text-button" type="button" data-action="refresh">Try again</button>
      </div>`;
  } else if (state.ingests.length === 0) {
    content = `
      <div class="list-message empty" data-testid="sessions-empty">
        <span class="message-glyph" aria-hidden="true">0</span>
        <p><strong>No sessions yet</strong><small>Your first synthetic ingest will appear here.</small></p>
      </div>`;
  } else {
    content = `<ol class="session-list">${state.ingests
      .map((ingest) => renderSessionRow(ingest, state.selectedId === ingest.id))
      .join("")}</ol>`;
  }

  return `
    <section class="sessions-card" aria-labelledby="sessions-title">
      <div class="list-header">
        <div>
          <p class="eyebrow">Local store</p>
          <h2 id="sessions-title">Sessions <span>${String(state.ingests.length).padStart(2, "0")}</span></h2>
        </div>
        <button class="icon-button" type="button" data-action="refresh" aria-label="Refresh sessions" ${refreshDisabled}>↻</button>
      </div>
      ${content}
    </section>
  `;
}

function renderSessionRow(ingest: BetaIngest, selected: boolean): string {
  const status = statusPresentation(ingest.status);
  return `
    <li>
      <button
        class="session-row ${selected ? "selected" : ""}"
        type="button"
        data-session-id="${escapeHtml(ingest.id)}"
        data-testid="session-row"
        ${selected ? 'aria-current="true"' : ""}
      >
        <span class="session-row-top">
          <span class="status-label ${status.className}"><i aria-hidden="true"></i>${status.label}</span>
          <time datetime="${escapeHtml(ingest.created_at)}">${escapeHtml(formatCreatedAt(ingest.created_at))}</time>
        </span>
        <strong>Session ${escapeHtml(shortId(ingest.id))}</strong>
        <span class="session-row-meta">${ingest.transcript?.segments.length ?? 0} transcript segments <b aria-hidden="true">→</b></span>
      </button>
    </li>
  `;
}

function renderPreview(state: ReviewUiState): string {
  if (state.selectedId === null) {
    return `
      <div class="preview-message" data-testid="session-unselected">
        <div class="preview-orbit" aria-hidden="true"><span></span></div>
        <p class="eyebrow">Nothing loaded</p>
        <h2>Choose a stored session.</h2>
        <p>Select a session from the local list to request its preview. No request is sent without a session ID.</p>
      </div>
    `;
  }
  if (state.previewPhase === "loading") {
    return `
      <div class="preview-message" data-testid="session-loading" role="status">
        <span class="spinner large" aria-hidden="true"></span>
        <p class="eyebrow">Reading local store</p>
        <h2>Loading the persisted session…</h2>
      </div>
    `;
  }
  if (state.previewPhase === "error" || state.selectedIngest === null) {
    return `
      <div class="preview-message" data-testid="session-unavailable">
        <div class="preview-orbit warning" aria-hidden="true"><span>!</span></div>
        <p class="eyebrow">Preview closed</p>
        <h2>This session is unavailable.</h2>
        <p>It may not exist for this synthetic tenant. The local Beta does not reveal another tenant's records.</p>
        <button class="secondary-button" type="button" data-action="retry-preview">Retry this session</button>
      </div>
    `;
  }
  return renderIngest(state.selectedIngest);
}

function renderIngest(ingest: BetaIngest): string {
  const status = statusPresentation(ingest.status);
  const transcript = ingest.transcript === null
    ? renderTranscriptEmpty()
    : renderTranscript(ingest);
  return `
    <article class="session-preview" data-testid="session-preview" aria-labelledby="preview-title">
      <header class="preview-header">
        <div>
          <p class="eyebrow">Persisted session</p>
          <h2 id="preview-title">Review ${escapeHtml(shortId(ingest.id))}</h2>
        </div>
        <span class="status-label ${status.className}"><i aria-hidden="true"></i>${status.label}</span>
      </header>
      <dl class="session-facts">
        <div><dt>Created</dt><dd><time datetime="${escapeHtml(ingest.created_at)}">${escapeHtml(formatCreatedAt(ingest.created_at))}</time></dd></div>
        <div><dt>Session ID</dt><dd title="${escapeHtml(ingest.id)}">${escapeHtml(shortId(ingest.id))}</dd></div>
        <div><dt>Language</dt><dd>${escapeHtml(ingest.transcript?.language_code ?? "Pending")}</dd></div>
        <div><dt>Source</dt><dd>Synthetic fixture</dd></div>
      </dl>
      ${transcript}
    </article>
  `;
}

function renderTranscriptEmpty(): string {
  return `
    <section class="transcript-empty" data-testid="transcript-empty">
      <span class="spinner large" aria-hidden="true"></span>
      <p class="eyebrow">Transcript processing</p>
      <h3>The ingest is safely stored.</h3>
      <p>This synthetic session has no transcript yet. Refresh the session when a transcript is available.</p>
    </section>
  `;
}

function renderTranscript(ingest: BetaIngest): string {
  const transcript = ingest.transcript;
  if (transcript === null) return renderTranscriptEmpty();
  return `
    <section class="transcript" aria-labelledby="transcript-title">
      <div class="transcript-heading">
        <div>
          <p class="eyebrow">Read-only transcript</p>
          <h3 id="transcript-title">Conversation</h3>
        </div>
        <span>${String(transcript.segments.length).padStart(2, "0")} segments</span>
      </div>
      <ol class="transcript-list">
        ${transcript.segments.map((segment) => `
          <li>
            <span class="timeline-dot ${segment.speaker === "Clinician" ? "clinician" : "participant"}" aria-hidden="true"></span>
            <div class="segment-meta">
              <strong>${escapeHtml(segment.speaker)}</strong>
              <time>${escapeHtml(formatOffset(segment.offset_ms))}</time>
            </div>
            <p>${escapeHtml(segment.text)}</p>
          </li>
        `).join("")}
      </ol>
      <p class="transcript-footnote">Synthetic dialogue · read-only local preview</p>
    </section>
  `;
}

function statusPresentation(status: BetaIngestStatus): { label: string; className: string } {
  return status === "ready_for_review"
    ? { label: "Ready for review", className: "ready" }
    : { label: "Processing", className: "processing" };
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function formatOffset(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return value.replace(/[&<>"']/gu, (character) => replacements[character] ?? "");
}
