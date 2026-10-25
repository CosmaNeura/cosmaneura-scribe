/* global window, document, innerWidth */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.navigationMediaCalls = 0;
    for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, method, { value: () => {
      window.navigationMediaCalls++;
      throw new Error("Physical media is forbidden in navigation tests");
    } });
  });
});

for (const platform of ["desktop", "ios"]) {
  test(`${platform} refresh preserves the visit without replaying capture and stays blocked during recording`, async ({ page }) => {
    await page.setViewportSize({ width: platform === "desktop" ? 1280 : 320, height: 844 });
    await page.goto(`/e2e/fixtures/optional-dob.html?platform=${platform}&recents`);
    const row = page.locator('[data-visit-ref="appointment_01j00000000000000000000000"]');
    await row.getByRole("button", { name: "Start", exact: true }).click();
    const back = page.getByRole("button", { name: "Back to encounters", exact: true });
    const refresh = page.getByRole("button", { name: "Refresh current visit", exact: true });
    await expect(back).toBeInViewport(); await expect(refresh).toBeInViewport();
    const consent = page.getByRole("checkbox", { name: "The patient said yes", exact: true });
    const record = page.getByRole("button", { name: "Start recording", exact: true });
    await expect(consent).not.toBeChecked(); await expect(record).toBeDisabled();
    expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
    await consent.click(); await record.click();
    await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
    await expect(refresh).toBeDisabled();
    await page.evaluate(() => window.dobLab.emit({ state: "paused", statusCode: "capture_paused",
      native: { phase: "stopPending", busy: true }, desktop: { phase: "stop_unconfirmed", audioMode: "microphone" } }));
    await expect(refresh).toBeDisabled();
    await page.evaluate(() => window.dobLab.emit({ state: "paused", statusCode: "capture_paused",
      native: { phase: "paused", busy: false }, desktop: { phase: "interrupted", audioMode: "microphone" } }));
    await expect(refresh).toBeEnabled(); await refresh.click();
    await expect.poll(() => page.evaluate(() => window.dobLab.closes)).toBe(1);
    expect(await page.evaluate(() => window.dobLab.openedRefs)).toEqual([
      "appointment_01j00000000000000000000000", "appointment_01j00000000000000000000000",
    ]);
    expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 1]);
    await back.click();
    await expect(page.getByRole("list", { name: "Authorized encounters", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.navigationMediaCalls)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("refresh keeps unsaved note edits until an explicit decision and saves once before reopening", async ({ context, page, baseURL }) => {
  const server = await installNoteServer(context, { loseSaveResponse: false, origin: baseURL });
  await page.goto("/e2e/fixtures/provider-note.html");
  await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
  const openNote = () => page.getByRole("button", { name: /^(Continue to note|Review draft note)$/u }).click();
  await openNote();
  const plan = page.getByRole("textbox", { name: "Plan", exact: true });
  await plan.fill("Synthetic retained navigation edit.");
  const refresh = page.getByRole("button", { name: "Refresh current visit", exact: true });
  await refresh.click();
  await expect(page.getByRole("dialog", { name: "Keep your note edits?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(plan).toHaveValue("Synthetic retained navigation edit.");
  expect(server.calls.filter(call => call === "save")).toHaveLength(0);
  await refresh.click(); await page.getByRole("button", { name: "Save & continue", exact: true }).click();
  await expect(plan).not.toBeVisible(); await openNote();
  await expect(plan).toHaveValue("Synthetic retained navigation edit.");
  expect(server.calls.filter(call => call === "save")).toHaveLength(1);
  expect(await page.evaluate(() => window.navigationMediaCalls)).toBe(0);
  server.assertHealthy();
});

for (const completed of [false, true]) {
  test(`refresh from ${completed ? "saved for review" : "a generated draft"} keeps saved-passage playback in transcript review`, async ({ context, page, baseURL }) => {
    const server = await installNoteServer(context, { loseSaveResponse: false, origin: baseURL, draftPending: true });
    await page.goto("/e2e/fixtures/provider-note.html?saved-audio");
    await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
    await page.getByRole("button", { name: "Review draft note", exact: true }).click();
    await page.getByRole("button", { name: "Write visit note", exact: true }).click();
    await expect.poll(() => server.calls.filter(call => call === "prepare").length).toBe(1);
    server.releaseDraft();
    const plan = page.getByRole("textbox", { name: "Plan", exact: true });
    await expect(plan).toBeVisible();
    if (completed) {
      await page.getByRole("button", { name: "Save and review", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Saved for review", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.noteLab.dashboardOpens)).toBe(1);
    }
    const refresh = page.getByRole("button", { name: "Refresh current visit", exact: true });
    await expect(refresh).toBeVisible(); await expect(refresh).toBeEnabled(); await refresh.click();
    await expect(plan).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Review draft note", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Listen to passage", exact: true }).click();
    const audio = page.getByLabel("Recorded passage, up to 30 seconds", { exact: true });
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0);
    await expect.poll(() => audio.evaluate(element => element.ended)).toBe(true);
    expect(await audio.evaluate(element => ({ duration: element.duration, error: element.error, source: element.getAttribute("src")?.startsWith("blob:") })))
      .toEqual({ duration: 4, error: null, source: true });
    await expect(plan).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Review draft note", exact: true })).toBeVisible();
    expect(server.calls.filter(call => ["prepare", "save", "resolve", "save_status"].includes(call))).toEqual(["prepare"]);
    expect(await page.evaluate(() => [window.noteLab.passageReads, window.navigationMediaCalls])).toEqual([1, 0]);
    server.assertHealthy();
  });
}
