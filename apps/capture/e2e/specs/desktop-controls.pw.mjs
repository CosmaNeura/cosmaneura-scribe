/* global window */
import { expect, test } from "@playwright/test";

for (const width of [1280, 640]) {
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
    await expect(page.getByRole("button", { name: "Stop and upload", exact: true })).toBeHidden();
    await start.click();
    await expect(controls).toContainText("Recording has not started.");
    await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toBeEnabled();
    await expect(start).toBeHidden();
    await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("chooser-pending.png") });
    await page.evaluate(() => window.desktopControlsLab.choose());
    await expect(controls.locator(".recording-duration")).toContainText("1:23");
    const pause = controls.getByRole("button", { name: "Pause recording", exact: true });
    const stop = controls.getByRole("button", { name: "Stop and upload", exact: true });
    await expect(pause).toBeEnabled();
    await expect(pause).toBeInViewport();
    await expect(stop).toBeInViewport();
    await expect(controls.getByRole("region", { name: "Recording progress" })).toHaveCount(1);
    await expect(start).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("recording.png") });
    await pause.click();
    await expect(controls).toContainText("Recording is paused.");
    await expect(pause).toHaveCount(0);
    const resume = controls.getByRole("button", { name: "Resume recording", exact: true });
    await expect(resume).toBeEnabled();
    await expect(resume).toBeInViewport();
    await expect(stop).toBeEnabled();
    await expect(stop).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("paused.png") });
    if (width === 1280) {
      await resume.click();
      await expect(pause).toBeEnabled();
    }
    await stop.click();
    await expect(controls).toContainText("Recording stop is unconfirmed.");
    await expect(controls.getByRole("button", { name: "Retry stop and upload", exact: true })).toBeEnabled();
    await expect(resume).toHaveCount(0);
    await expect(start).toBeHidden();
    expect(await page.evaluate(() => window.desktopControlsLab.commands))
      .toEqual(width === 1280 ? ["start", "pause", "resume", "stop"] : ["start", "pause", "stop"]);
    await page.evaluate(() => window.desktopControlsLab.close());
  });
}
