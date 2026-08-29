import { BetaApiError, HttpBetaApi, type BetaApi } from "./beta-api";
import { isUuid } from "./contracts";
import { renderReviewView, type ReviewUiState } from "./review-view";

export function startReviewApp(root: HTMLElement, configuredTenantId: unknown): void {
  const tenantId = isUuid(configuredTenantId) ? configuredTenantId.toLowerCase() : null;
  const application = new ReviewApplication(root, tenantId);
  application.start();
}

class ReviewApplication {
  private readonly api: BetaApi | null;
  private state: ReviewUiState;
  private pendingCreateKey: string | null = null;
  private previewRequest = 0;

  public constructor(
    private readonly root: HTMLElement,
    tenantId: string | null,
  ) {
    this.api = tenantId === null ? null : new HttpBetaApi(tenantId);
    this.state = {
      tenantId,
      ingests: [],
      listPhase: tenantId === null ? "idle" : "loading",
      selectedId: null,
      selectedIngest: null,
      previewPhase: "idle",
      createPhase: "idle",
      includeTranscript: true,
      notice: null,
    };
  }

  public start(): void {
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("change", this.onChange);
    this.root.addEventListener("submit", this.onSubmit);
    this.render();
    if (this.api !== null) void this.loadIngests();
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const sessionButton = target.closest("[data-session-id]");
    if (sessionButton instanceof HTMLButtonElement) {
      const ingestId = sessionButton.dataset.sessionId;
      if (ingestId === undefined || !isUuid(ingestId)) {
        this.closePreview();
        return;
      }
      void this.loadPreview(ingestId);
      return;
    }

    const actionButton = target.closest("[data-action]");
    if (!(actionButton instanceof HTMLButtonElement)) return;
    if (actionButton.dataset.action === "refresh") {
      void this.loadIngests();
    } else if (actionButton.dataset.action === "retry-preview") {
      if (this.state.selectedId === null) {
        this.closePreview();
      } else {
        void this.loadPreview(this.state.selectedId);
      }
    }
  };

  private readonly onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "include-transcript") return;
    this.pendingCreateKey = null;
    this.state = {
      ...this.state,
      includeTranscript: target.checked,
      createPhase: "idle",
      notice: null,
    };
    this.render();
  };

  private readonly onSubmit = (event: SubmitEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement) || target.dataset.action !== "create") return;
    event.preventDefault();
    void this.createIngest();
  };

  private async loadIngests(): Promise<void> {
    if (this.api === null) return;
    this.state = { ...this.state, listPhase: "loading" };
    this.render();
    try {
      const ingests = await this.api.listIngests();
      this.state = { ...this.state, ingests, listPhase: "ready" };
    } catch {
      this.state = { ...this.state, listPhase: "error" };
    }
    this.render();
  }

  private async loadPreview(ingestId: string): Promise<void> {
    if (this.api === null || !isUuid(ingestId)) {
      this.closePreview();
      return;
    }
    const request = ++this.previewRequest;
    this.state = {
      ...this.state,
      selectedId: ingestId,
      selectedIngest: null,
      previewPhase: "loading",
    };
    this.render();
    try {
      const ingest = await this.api.getIngest(ingestId);
      if (request !== this.previewRequest) return;
      this.state = { ...this.state, selectedIngest: ingest, previewPhase: "ready" };
    } catch {
      if (request !== this.previewRequest) return;
      this.state = { ...this.state, selectedIngest: null, previewPhase: "error" };
    }
    this.render();
  }

  private async createIngest(): Promise<void> {
    if (this.api === null || this.state.createPhase === "submitting") return;
    this.pendingCreateKey ??= `beta-${crypto.randomUUID()}`;
    this.state = {
      ...this.state,
      createPhase: "submitting",
      notice: "Saving the synthetic ingest to local memory…",
    };
    this.render();

    try {
      const created = await this.api.createIngest(
        this.state.includeTranscript,
        this.pendingCreateKey,
      );
      const [ingests, persisted] = await Promise.all([
        this.api.listIngests(),
        this.api.getIngest(created.id),
      ]);
      this.previewRequest += 1;
      this.pendingCreateKey = null;
      this.state = {
        ...this.state,
        ingests,
        listPhase: "ready",
        selectedId: persisted.id,
        selectedIngest: persisted,
        previewPhase: "ready",
        createPhase: "success",
        notice: "Saved and read back from the local store.",
      };
    } catch (error) {
      this.state = {
        ...this.state,
        createPhase: "error",
        notice: createFailureCopy(error),
      };
    }
    this.render();
  }

  private closePreview(): void {
    this.previewRequest += 1;
    this.state = {
      ...this.state,
      selectedId: null,
      selectedIngest: null,
      previewPhase: "idle",
    };
    this.render();
  }

  private render(): void {
    this.root.innerHTML = renderReviewView(this.state);
  }
}

function createFailureCopy(error: unknown): string {
  if (error instanceof BetaApiError && error.kind === "conflict") {
    return "That retry no longer matches its original request. Change the option to start fresh.";
  }
  if (error instanceof BetaApiError && error.kind === "invalid_response") {
    return "The local host returned an unexpected response. Nothing unsafe was displayed.";
  }
  return "The ingest could not be confirmed in the local store. Check the launcher and retry.";
}
