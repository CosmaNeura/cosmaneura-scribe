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
    await page.getByRole("button", { name: /Synthetic walk-in/u }).click();
    const back = page.getByRole("button", { name: "Back to encounters", exact: true });
    const refresh = page.getByRole("button", { name: "Refresh current visit", exact: true });
    await expect(back).toBeInViewport(); await expect(refresh).toBeInViewport();
    await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
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
