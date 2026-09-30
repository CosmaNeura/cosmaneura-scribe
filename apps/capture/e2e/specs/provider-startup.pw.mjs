/* global window */
import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`native startup remains cancelable before the first bridge reply at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      globalThis.__startupMediaCalls = 0;
      for (const method of ["getUserMedia", "getDisplayMedia"]) {
        Object.defineProperty(navigator.mediaDevices, method, { value: () => {
          globalThis.__startupMediaCalls += 1;
          throw new Error("Real media is forbidden in this virtual startup test");
        } });
      }
    });
    await page.goto(`/e2e/fixtures/provider-startup.html${width === 390 ? "?platform=ios" : ""}`);
    const controls = page.getByRole("region", { name: "Recording controls", exact: true });
    const progress = controls.getByRole("region", { name: "Recording progress", exact: true });
    await test.step("start", async () => {
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toBeEnabled();
      await expect(progress).toContainText("Recording is not confirmed yet.");
      await expect(progress).toContainText("Check the microphone feedback before continuing the visit.");
      await expect(progress).not.toContainText("advancing timer");
      await expect(progress).toContainText("Taking longer than expected.", { timeout: 6000 });
      await expect(progress).toBeInViewport();
      await expect(controls.getByRole("button", { name: "Cancel start", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("native-starting.png"), fullPage: true });
    });
    await test.step("cancel_start", async () => {
      await page.getByRole("button", { name: "Cancel start", exact: true }).click();
      // The first Start response remains deliberately unresolved. A confirmed
      // Pause must release the real adapter + UI's pending operation now.
      await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled({ timeout: 1500 });
      await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => window.startupLab.startCalls)).toBe(1);
      await expect(progress.getByRole("status")).toHaveText("Start canceledRecording has not started. Start when ready.");
      await expect(controls.getByRole("button", { name: "Start recording", exact: true })).toBeInViewport();
      await expect(controls.getByRole("button", { name: "Finish recording", exact: true })).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath("native-start-cancelled.png"), fullPage: true });
    });
    await test.step("resume", async () => {
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.startupLab.startCalls)).toBe(2);
      await page.evaluate(() => window.startupLab.releaseFirst());
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toHaveCount(0);
      if (width === 390) {
        await expect(controls.getByRole("heading", { name: "Checking microphone", exact: true })).toBeVisible();
        await expect(controls.getByText("Waiting for microphone signal. Say a few words and watch the bars. Audio input is not confirmed yet.", { exact: true })).toBeVisible();
        await expect(progress.locator('[role="status"]')).toBeHidden();
        await expect(controls.getByRole("button", { name: "Finish recording", exact: true })).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath("native-armed-no-input.png"), fullPage: true });
      }
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(progress.getByRole("status")).toHaveText("PausedNo audio is being recorded.");
      await expect(controls.getByRole("button", { name: "Finish recording", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("native-paused.png"), fullPage: true });
    });
    expect(await page.evaluate(() => globalThis.__startupMediaCalls)).toBe(0);
    expect(await page.evaluate(() => window.startupLab.commands)).not.toContain("seal");
    await page.evaluate(() => window.startupLab.close());
  });
}
