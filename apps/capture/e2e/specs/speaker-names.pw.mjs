/* global window, innerWidth */
import { expect, test } from "@playwright/test";

for (const width of [390, 780]) {
  test(`speaker shortcuts require a saved confirmation and fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/e2e/fixtures/speaker-names.html");
    await page.locator('[data-review-action="edit"]').click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[name="role"]')).toHaveValue("unknown");
    await expect(dialog.locator('[name="display_name"]')).toBeDisabled();
    const provider = dialog.locator('[data-speaker-role="clinician"]');
    await provider.focus(); await page.keyboard.press("Enter");
    await expect(dialog.locator('[name="role"]')).toHaveValue("clinician");
    await expect(dialog.locator('[name="display_name"]')).toHaveValue(await page.evaluate(() => window.speakerNamesLab.provider));
    expect(await page.evaluate(() => window.speakerNamesLab.writes.length)).toBe(0);
    expect(await page.evaluate(() => window.speakerNamesLab.saves.length)).toBe(0);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await provider.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await dialog.locator('[data-speaker-role="patient"]').click();
    await dialog.locator('[name="display_name"]').fill("Fictional manually corrected name");
    await page.screenshot({ path: testInfo.outputPath("speaker-confirmation.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Save correction", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.speakerNamesLab.writes.length)).toBe(1);
    expect(await page.evaluate(() => window.speakerNamesLab.writes[0].speakers)).toEqual([
      { speaker_id: "00000000-0000-4000-8000-000000000004", role: "patient", display_name: "Fictional manually corrected name", detail: null },
    ]);
    await page.evaluate(() => window.speakerNamesLab.dispose());
    await expect(dialog).toHaveCount(0);
  });
}
