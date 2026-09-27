import { expect, test } from "@playwright/test";

import { CapturePage } from "../pages/capture-page.mjs";
import { SYNTHETIC_TENANT_ID } from "../support/synthetic-tenant.mjs";

test("persists browser capture through the real API and PostgreSQL", async ({
  context,
  page,
  request,
}) => {
  const apiOrigin = "http://127.0.0.1:4175";
  const tenantHeaders = { "X-Tenant-ID": SYNTHETIC_TENANT_ID };
  const uploadBytes = [];
  let createdSessionId;
  let transcriptionPolls = 0;
  let seededTranscriptStatus;
  page.on("response", async response => {
    if (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/capture/sessions"
      && response.status() === 201
    ) {
      createdSessionId = (await response.json()).id;
    }
  });
  // services/api has no transcription-status route, so the browser's poll is
  // answered in-page. When it first reports completion, the transcript is written
  // through the real API route a transcription provider would use, so the browser's
  // subsequent GET /transcript reads persisted data rather than a stub.
  await context.route("**/api/capture/sessions/*/transcription-status", async route => {
    transcriptionPolls += 1;
    const sessionId = new URL(route.request().url()).pathname.split("/").at(-2);
    const ready = transcriptionPolls >= 2;
    if (ready && seededTranscriptStatus === undefined) {
      const seeded = await request.post(`${apiOrigin}/v1/sessions/${sessionId}/transcript`, {
        headers: { ...tenantHeaders, "Idempotency-Key": `seed-transcript-${sessionId}` },
        data: {
          language_code: "en-US",
          stt_provider: "synthetic-e2e-provider",
          segments: [{
            speaker_id: "synthetic-clinician",
            speaker_role: "clinician",
            content: "Synthetic transcript content for preview only.",
            start_ms: 0,
            end_ms: 1_000,
            confidence: 1,
          }],
        },
      });
      seededTranscriptStatus = seeded.status();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session_id: sessionId,
        status: ready ? "completed" : "processing",
        transcript_available: ready,
        updated_at: new Date().toISOString(),
      }),
    });
  });
  await context.route("http://127.0.0.1:5173/real-upload/**", async route => {
    uploadBytes.push((await route.request().postDataBuffer())?.byteLength ?? 0);
    await route.fulfill({ status: 201, body: "" });
  });

  const capture = new CapturePage(page);
  await capture.open("idle");
  await capture.acceptConsentAndPrepare();
  await capture.startRecording();
  await capture.waitForDurableEncryptedChunk();
  await capture.stopButton.click();
  await capture.waitForCompletion();
  expect(seededTranscriptStatus).toBe(201);
  expect(uploadBytes.length).toBeGreaterThanOrEqual(1);
  for (const byteLength of uploadBytes) {
    expect(byteLength).toBeGreaterThan(0);
  }

  const response = await request.get(`${apiOrigin}/__e2e__/evidence`);
  expect(response.ok()).toBe(true);
  const evidence = await response.json();
  expect(createdSessionId).toBeTruthy();
  expect(evidence.session_id).toBe(createdSessionId);
  expect(evidence.status).toBe("transcript_ready");
  expect(evidence.chunk_count).toBeGreaterThanOrEqual(1);
  expect(evidence.audit_actions).toEqual(expect.arrayContaining([
    "consent.recorded",
    "scribe_session.created",
    "session_audio_key.bound",
    "capture_lease.issued",
    "audio_chunk_reservations.created",
    "audio_upload_authorization.issued",
    "audio_chunk.registered",
    "scribe_session.uploaded",
    "transcript.created",
    "transcript.read",
  ]));
});
