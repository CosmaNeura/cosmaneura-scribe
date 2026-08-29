import { describe, expect, it, vi } from "vitest";

import { BetaApiError, HttpBetaApi } from "./beta-api";

const TENANT_ID = "00000000-0000-4000-8000-000000000029";
const INGEST_ID = "11111111-1111-4111-8111-111111111111";

function ingestDocument(tenantId = TENANT_ID): Record<string, unknown> {
  return {
    id: INGEST_ID,
    tenant_id: tenantId,
    status: "ready_for_review",
    created_at: "2026-08-29T16:30:00Z",
    transcript: {
      language_code: "en-US",
      segments: [
        {
          speaker: "Clinician",
          offset_ms: 0,
          duration_ms: 1_000,
          text: "Synthetic transcript fixture.",
        },
      ],
    },
  };
}

describe("HttpBetaApi", () => {
  it("creates only through the same-origin tenant-scoped endpoint", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(ingestDocument(), { status: 201 }),
    );
    const api = new HttpBetaApi(TENANT_ID, fetchImplementation);

    const created = await api.createIngest(true, "beta-request-0001");

    expect(created.id).toBe(INGEST_ID);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(path).toBe("/api/beta/ingests");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Tenant-ID")).toBe(TENANT_ID);
    expect(headers.get("Idempotency-Key")).toBe("beta-request-0001");
    expect(init?.body).toBe(JSON.stringify({ include_transcript: true }));
  });

  it("fails before fetching when tenant or session context is invalid", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();

    expect(() => new HttpBetaApi("", fetchImplementation)).toThrow(BetaApiError);
    const api = new HttpBetaApi(TENANT_ID, fetchImplementation);
    await expect(api.getIngest("missing-id")).rejects.toMatchObject({
      kind: "configuration",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects a response that claims a different tenant", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(ingestDocument("00000000-0000-4000-8000-000000000030")),
    );
    const api = new HttpBetaApi(TENANT_ID, fetchImplementation);

    await expect(api.getIngest(INGEST_ID)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("does not parse or expose an error response body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ detail: "sensitive upstream detail" }, { status: 404 }),
    );
    const api = new HttpBetaApi(TENANT_ID, fetchImplementation);

    await expect(api.getIngest(INGEST_ID)).rejects.toEqual(
      expect.objectContaining({ kind: "not_found", status: 404 }),
    );
  });
});
