/* global window, document */
import { expect, test } from "@playwright/test";

for (const { width, height, largeText } of [
  { width: 402, height: 874, largeText: false },
  { width: 320, height: 568, largeText: false },
  { width: 480, height: 332, largeText: false },
  { width: 402, height: 874, largeText: true },
]) test(`native recorder keeps Pause and Finish reachable at ${width}x${height}, larger text=${largeText}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    window.layoutMediaCalls = 0;
    for (const name of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, name,
      { value: () => { window.layoutMediaCalls++; throw new Error("Real media forbidden"); } });
  });
  await page.goto("/e2e/fixtures/optional-dob.html?platform=ios&recents&layout&long-name&quiet-input");
  // Match the native safe area: the observed 402×874 app starts its web content at y=61.
  await page.addStyleTag({ content: `.provider-application { padding-top: ${height > 400 ? 61 : 0}px !important; padding-bottom: 34px !important; }` });
  if (largeText) await page.addStyleTag({ content: "html { font-size: 24px !important; }" });
  await page.locator('.provider-encounters [data-workspace-action="open"]').click();
  await page.getByRole("checkbox", { name: "The patient said yes", exact: true }).click();
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
  const controls = page.getByRole("region", { name: "Recording controls", exact: true });
  const pause = controls.getByRole("button", { name: "Pause", exact: true });
  const finish = controls.getByRole("button", { name: "Finish visit", exact: true });
  await expect(page.getByText("No sound detected", { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("recording-initial.png") });
  for (const button of [pause, finish]) {
    await expect(button).toBeEnabled();
    await expect(button).toBeInViewport({ ratio: 1 });
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate(element => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await expect(page.locator("[data-provider-encounter]")).toHaveText("Casey Vale Dublin R2 Bulk Clear");
  // The full advisory remains readable, including its suggested Pause action.
  await page.locator("scribe-ios-input-meter").evaluate(element => element.scrollIntoView({ block: "start" }));
  const advisoryTitle = page.getByText("No sound detected", { exact: true });
  await expect(advisoryTitle).toBeInViewport({ ratio: 1 });
  expect((await advisoryTitle.boundingBox()).y).toBeGreaterThanOrEqual(
    await page.locator(".native-recording-essential").evaluate(element => element.getBoundingClientRect().bottom));
  await expect(page.getByText("Say a few words and watch the bars.", { exact: false })).toBeInViewport({ ratio: 1 });
  await expect(pause).toBeInViewport({ ratio: 1 });
  await expect(finish).toBeInViewport({ ratio: 1 });
  await pause.focus();
  await page.keyboard.press("Tab");
  await expect(finish).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("reading-advisory.png") });
  await pause.click();
  const resume = controls.getByRole("button", { name: "Resume recording", exact: true });
  await expect(resume).toBeEnabled();
  await expect(finish).toBeEnabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(resume).toBeInViewport({ ratio: 1 });
  await expect(finish).toBeInViewport({ ratio: 1 });
  await expect(controls).toContainText("No audio is being recorded.");
  await page.screenshot({ path: testInfo.outputPath("paused.png") });
  await resume.click();
  await expect(pause).toBeEnabled();
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts, window.layoutMediaCalls])).toEqual([1, 1, 0]);
  await page.evaluate(() => window.dobLab.signOut());
});
