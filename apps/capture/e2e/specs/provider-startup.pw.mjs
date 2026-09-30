/* global window */
import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`native startup remains cancelable before the first bridge reply at ${width}px`, async ({ page }) => {
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
    await page.goto("/e2e/fixtures/provider-startup.html");
    await test.step("start", async () => {
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toBeEnabled();
    });
    await test.step("cancel_start", async () => {
      await page.getByRole("button", { name: "Cancel start", exact: true }).click();
      // The first Start response remains deliberately unresolved. A confirmed
      // Pause must release the real adapter + UI's pending operation now.
      await expect(page.getByRole("button", { name: "Resume recording", exact: true })).toBeEnabled({ timeout: 1500 });
      await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => window.startupLab.startCalls)).toBe(1);
    });
    await test.step("resume", async () => {
      await page.getByRole("button", { name: "Resume recording", exact: true }).click();
      await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => window.startupLab.startCalls)).toBe(2);
      await page.evaluate(() => window.startupLab.releaseFirst());
      await expect(page.getByRole("button", { name: "Pause recording", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toHaveCount(0);
    });
    expect(await page.evaluate(() => globalThis.__startupMediaCalls)).toBe(0);
    expect(await page.evaluate(() => window.startupLab.commands)).not.toContain("seal");
    await page.evaluate(() => window.startupLab.close());
  });
}
