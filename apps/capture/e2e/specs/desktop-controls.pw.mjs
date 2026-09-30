/* global window, document */
import { expect, test } from "@playwright/test";

test("interruption confirmation hides Resume until settled and keeps lost-reply recovery visible", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 332 });
  await page.goto("/e2e/fixtures/desktop-controls.html");
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await page.evaluate(() => window.desktopControlsLab.choose());
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await page.evaluate(() => window.desktopControlsLab.confirming());
  await expect(page.getByRole("status")).toHaveText("Confirming recording stopped…");
  await expect(resume).toHaveCount(0);
  await page.evaluate(() => window.desktopControlsLab.confirmationLost());
  await expect(page.getByRole("status")).toHaveText("Recording has stopped. Retry confirmation before uploading.");
  await expect(resume).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry confirmation and upload", exact: true })).toBeInViewport();
  await page.evaluate(() => window.desktopControlsLab.settledPause());
  await expect(resume).toBeEnabled();
  await expect(resume).toBeInViewport();
  await page.evaluate(() => window.desktopControlsLab.close());
});

for (const width of [1280, 640, 480]) {
  test(`desktop controls stay together through choose, record, pause and failed stop at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      for (const method of ["getUserMedia", "getDisplayMedia"]) {
        Object.defineProperty(navigator.mediaDevices, method, { value: () => {
          throw new Error("Real media forbidden");
        } });
      }
    });
    await page.goto("/e2e/fixtures/desktop-controls.html");
    const controls = page.getByRole("region", { name: "Recording controls", exact: true });
    const start = page.getByRole("button", { name: "Start recording", exact: true });
    await expect(start).toBeVisible();
    await expect(page.getByRole("button", { name: "Finish recording", exact: true })).toBeHidden();
    await start.click();
    await expect(controls).toContainText("Recording has not started.");
    await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toBeEnabled();
    await expect(start).toBeHidden();
    await page.getByRole("button", { name: "Show window chooser", exact: true }).click();
    await expect(controls).toContainText("Recording has not started.");
    await expect(controls.getByLabel("Current visit")).toContainText("Avery Example");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("chooser-pending.png") });
    await page.evaluate(() => window.desktopControlsLab.choose());
    if (width === 480) await page.setViewportSize({ width, height: 332 });
    await expect(controls.locator(".recording-duration")).toContainText("1:23");
    const pause = controls.getByRole("button", { name: "Pause", exact: true });
    const stop = controls.getByRole("button", { name: "Finish recording", exact: true });
    await expect(pause).toBeEnabled();
    await expect(controls.getByRole("meter", { name: "Microphone", exact: true })).toHaveAttribute("value", "70");
    await expect(controls.getByRole("meter", { name: "Meeting audio", exact: true })).toHaveAttribute("value", "80");
    await expect(pause).toBeInViewport();
    await expect(stop).toBeInViewport();
    await expect(controls.getByRole("region", { name: "Recording progress" })).toHaveCount(1);
    await expect(start).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("recording.png") });
    await pause.click();
    await expect(controls.getByRole("status")).toHaveText("PausedNo audio is being recorded.");
    await expect(pause).toHaveCount(0);
    const resume = controls.getByRole("button", { name: "Resume", exact: true });
    await expect(resume).toBeEnabled();
    await expect(resume).toBeInViewport();
    await expect(stop).toBeEnabled();
    await expect(stop).toBeInViewport();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeHidden();
    if (width === 480) {
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(332);
      await expect(controls.locator(".recording-source-help")).toBeInViewport();
    }
    await page.screenshot({ path: testInfo.outputPath("paused.png") });
    if (width === 1280) {
      await resume.click();
      await expect(pause).toBeEnabled();
    }
    await page.evaluate(() => window.desktopControlsLab.incomplete());
    await expect(page.getByText("Recording coverage is incomplete.", { exact: false })).toBeVisible();
    await stop.click();

    await expect(controls).toContainText("Recording stop is unconfirmed.");
    await expect(controls.getByRole("button", { name: "Retry finish recording", exact: true })).toBeEnabled();
    await expect(resume).toHaveCount(0);
    await expect(start).toBeHidden();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeHidden();
    await expect(controls.getByRole("button", { name: "Retry finish recording", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => window.desktopControlsLab.commands))
      .toEqual(width === 1280 ? ["start", "show_chooser", "pause", "resume", "stop"] : ["start", "show_chooser", "pause", "stop"]);
    await page.evaluate(() => window.desktopControlsLab.close());
  });
}

test("desktop meters expire stale IPC and never invent activity for silence or a missing source", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 332 });
  await page.goto("/e2e/fixtures/desktop-controls.html");
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await page.evaluate(() => window.desktopControlsLab.choose());
  const mic = page.getByRole("meter", { name: "Microphone", exact: true });
  const meeting = page.getByRole("meter", { name: "Meeting audio", exact: true });
  await expect(mic).toHaveAttribute("value", "70");
  await expect(mic).toHaveAttribute("value", "0", { timeout: 2500 });
  await expect(meeting).toHaveAttribute("value", "0");
  await expect(page.getByText("Checking input", { exact: true })).toHaveCount(2);
  await page.evaluate(() => window.desktopControlsLab.quiet());
  await expect(page.getByText("No sound detected", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Checking input", { exact: true })).toHaveCount(1);
  await expect(mic).toHaveAttribute("value", "0");
  await expect(page.getByRole("button", { name: "Finish recording", exact: true })).toBeInViewport();
  await page.evaluate(() => window.desktopControlsLab.close());
});
