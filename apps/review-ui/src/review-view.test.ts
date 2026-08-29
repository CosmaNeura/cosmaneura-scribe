import { describe, expect, it } from "vitest";

import type { BetaIngest } from "./contracts";
import { renderReviewView, type ReviewUiState } from "./review-view";

const TENANT_ID = "00000000-0000-4000-8000-000000000029";
const STORED_INGEST: BetaIngest = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: TENANT_ID,
  status: "ready_for_review",
  created_at: "2026-08-29T16:30:00.000Z",
  transcript: {
    language_code: "en-US",
    segments: [
      {
        speaker: "Clinician",
        offset_ms: 0,
        duration_ms: 1_200,
        text: "The synthetic ingest persisted locally.",
      },
      {
        speaker: "Participant",
        offset_ms: 1_500,
        duration_ms: 1_000,
        text: "Ready for review.",
      },
    ],
  },
};

function state(overrides: Partial<ReviewUiState> = {}): ReviewUiState {
  return {
    tenantId: TENANT_ID,
    ingests: [],
    listPhase: "ready",
    selectedId: null,
    selectedIngest: null,
    previewPhase: "idle",
    createPhase: "idle",
    includeTranscript: true,
    notice: null,
    ...overrides,
  };
}

describe("renderReviewView", () => {
  it("renders the founder-path empty state and ingest form", () => {
    const markup = renderReviewView(state());

    expect(markup).toContain('data-testid="sessions-empty"');
    expect(markup).toContain("No sessions yet");
    expect(markup).toContain('data-testid="create-ingest"');
    expect(markup).toContain("Create synthetic ingest");
    expect(markup).toContain('data-testid="session-unselected"');
  });

  it("renders a stored session and its transcript", () => {
    const markup = renderReviewView(state({
      ingests: [STORED_INGEST],
      selectedId: STORED_INGEST.id,
      selectedIngest: STORED_INGEST,
      previewPhase: "ready",
    }));

    expect(markup).toContain('data-testid="session-row"');
    expect(markup).toContain('data-testid="session-preview"');
    expect(markup).toContain("Ready for review");
    expect(markup).toContain("The synthetic ingest persisted locally.");
    expect(markup).toContain("02 segments");
  });

  it("locks requests when the tenant fixture is absent", () => {
    const markup = renderReviewView(state({ tenantId: null, listPhase: "idle" }));

    expect(markup).toContain('data-testid="tenant-missing"');
    expect(markup).toContain("Requests locked");
    expect(markup).not.toContain('data-testid="create-ingest"');
  });

  it("renders the transcript empty state for a processing ingest", () => {
    const processing: BetaIngest = {
      ...STORED_INGEST,
      status: "processing",
      transcript: null,
    };
    const markup = renderReviewView(state({
      ingests: [processing],
      selectedId: processing.id,
      selectedIngest: processing,
      previewPhase: "ready",
    }));

    expect(markup).toContain('data-testid="transcript-empty"');
    expect(markup).toContain("The ingest is safely stored.");
  });

  it("escapes transcript text before it reaches the HTML renderer", () => {
    const unsafe: BetaIngest = {
      ...STORED_INGEST,
      transcript: {
        language_code: "en-US",
        segments: [{
          speaker: "Participant",
          offset_ms: 0,
          duration_ms: 1_000,
          text: '<img src=x onerror="alert(1)">',
        }],
      },
    };
    const markup = renderReviewView(state({
      selectedId: unsafe.id,
      selectedIngest: unsafe,
      previewPhase: "ready",
    }));

    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).not.toContain('<img src=x onerror="alert(1)">');
  });
});
