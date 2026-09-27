import { expect, test } from "@playwright/test";

import { CapturePage } from "../pages/capture-page.mjs";

test("persists browser capture through the real API and PostgreSQL", async ({
  context,
  page,
  request,
}) => {
  let uploads = 0;
  let transcriptionPolls = 0;
  await context.route("**/api/capture/sessions/*/transcription-status", async route => {
    transcriptionPolls += 1;
    const sessionId = new URL(route.request().url()).pathname.split("/").at(-2);
    const ready = transcriptionPolls >= 2;
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
  await context.route("**/api/capture/sessions/*/transcript", async route => {
    const sessionId = new URL(route.request().url()).pathname.split("/").at(-2);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "77777777-7777-4777-8777-777777777777",
        session_id: sessionId,
        language_code: "en-US",
        stt_provider: "synthetic-e2e-provider",
        created_at: new Date().toISOString(),
        segments: [{
          speaker_id: "synthetic-clinician",
          speaker_role: "clinician",
          content: "Synthetic transcript content for preview only.",
          start_ms: 0,
          end_ms: 1_000,
          confidence: 1,
        }],
      }),
    });
  });
  await context.route("http://127.0.0.1:5173/real-upload/**", async route => {
    uploads += 1;
    expect((await route.request().postDataBuffer())?.byteLength).toBeGreaterThan(0);
    await route.fulfill({ status: 201, body: "" });
  });

  const capture = new CapturePage(page);
  await capture.open("idle");
  await capture.acceptConsentAndPrepare();
  await capture.startRecording();
  await capture.waitForDurableEncryptedChunk();
  await capture.stopButton.click();
  await capture.waitForCompletion();
  expect(uploads).toBeGreaterThanOrEqual(1);

  const response = await request.get("http://127.0.0.1:4175/__e2e__/evidence");
  expect(response.ok()).toBe(true);
  const evidence = await response.json();
  expect(evidence.status).toBe("uploaded");
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
  ]));
});
