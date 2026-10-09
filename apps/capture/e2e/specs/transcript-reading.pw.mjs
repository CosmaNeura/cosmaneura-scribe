/* global window, document, innerWidth */
import { expect, test } from "@playwright/test";

for (const width of [780, 390]) {
  test(`long transcript remains exact and readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/e2e/fixtures/transcript-reading.html");
    const rows = page.locator(".creator-segment");
    await expect(rows).toHaveCount(3);
    await expect(page.getByText("Speaker 1 · not identified", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Speaker 2 · not identified", { exact: true })).toHaveCount(1);
    const actual = await rows.evaluateAll(elements => elements.map(element =>
      [...element.querySelectorAll(".creator-language-grid p")].map(part => part.textContent).join("")));
    expect(actual).toEqual(await page.evaluate(() => window.transcriptReadingLab.contents));
    for (const row of await rows.all()) expect(await row.locator(".creator-language-grid p").count()).toBeGreaterThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("transcript.png"), fullPage: true });
  });
}
