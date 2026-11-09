/* global document, window */
import { expect, test } from "@playwright/test";

async function create(page) {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=ios&draft-consent&gate-create&gate-open");
  await page.getByRole("button", { name: "+ Walk-in or new patient", exact: true }).click();
  await page.getByRole("textbox", { name: "Patient’s name", exact: true }).fill("Synthetic preparation patient");
  await page.getByRole("button", { name: "Continue to recording setup", exact: true }).click();
  await expect(page.locator('[name="draft-consent"]')).toBeVisible();
}

test("consent is usable with creation and opening delayed, but Record waits for authorization", async ({ page }) => {
  await create(page);
  await page.locator('[name="draft-consent"]').check();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => [window.dobLab.creates.length, window.dobLab.openedRefs.length,
    window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 0, 0, 0]);
  await page.evaluate(() => window.dobLab.releaseCreate());
  await expect.poll(() => page.evaluate(() => window.dobLab.openedRefs.length)).toBe(1);
  await expect(page.locator('[name="draft-consent"]')).toBeChecked();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeDisabled();
  await page.evaluate(() => window.dobLab.releaseOpen());
  await expect(page.locator('[name="consent"]')).toBeChecked();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
});

test("withdrawing consent during opening keeps Record unavailable", async ({ page }) => {
  await create(page); await page.locator('[name="draft-consent"]').check();
  await page.evaluate(() => window.dobLab.releaseCreate());
  await expect.poll(() => page.evaluate(() => window.dobLab.openedRefs.length)).toBe(1);
  await page.locator('[name="draft-consent"]').uncheck();
  await page.evaluate(() => window.dobLab.releaseOpen());
  await expect(page.locator('[name="consent"]')).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeDisabled();
});

test("a changed patient identity requires fresh consent", async ({ page }) => {
  await create(page); await page.locator('[name="draft-consent"]').check();
  await page.evaluate(() => { window.dobLab.renameDuringOpen = true; window.dobLab.releaseCreate(); window.dobLab.releaseOpen(); });
  await expect(page.locator('[name="consent"]')).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeDisabled();
});

test("cancelled creation cannot turn a late reply into recording access", async ({ page }) => {
  await create(page); await page.locator('[name="draft-consent"]').check();
  await page.getByRole("button", { name: "Cancel preparation", exact: true }).click();
  await page.evaluate(() => window.dobLab.releaseCreate());
  await expect(page.getByRole("heading", { name: "Check encounter creation", exact: true })).toBeVisible();
  expect(await page.evaluate(() => [window.dobLab.creates.length, window.dobLab.openedRefs.length,
    window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 0, 0, 0]);
});

test("failed opening preserves navigation without enabling recording", async ({ page }) => {
  await create(page); await page.locator('[name="draft-consent"]').check();
  await page.evaluate(() => { window.dobLab.failOpen = true; window.dobLab.releaseCreate(); window.dobLab.releaseOpen(); });
  await expect(page.locator(".provider-header")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to encounters", exact: true }).click();
  await expect(page.locator("[data-draft-consent]")).toHaveCount(0);
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
});

for (const width of [320, 390]) {
  test(`consent controls stay separated while creation and opening load at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await create(page);
    if (width === 320) await page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
    const card = page.locator("[data-draft-consent]");
    await card.evaluate(element => { element.dataset.retainedTest = "original"; });
    await page.locator('[name="draft-consent"]').check();
    const separated = async () => {
      const selectors = [".provider-consent-script", ".provider-consent", ".provider-primary", "#provider-draft-status", '[data-workspace-action="cancel-patient-creation"]'];
      const boxes = await Promise.all(selectors.map(selector => card.locator(selector).boundingBox()));
      for (const box of boxes) {
        expect(box).not.toBeNull(); expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height + 4);
      expect(boxes.at(-1).height).toBeGreaterThanOrEqual(44);
      await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeDisabled();
    };
    await separated();
    await page.evaluate(() => window.dobLab.releaseCreate());
    await expect.poll(() => page.evaluate(() => window.dobLab.openedRefs.length)).toBe(1);
    await expect(card).toHaveAttribute("data-retained-test", "original");
    await expect(page.locator(".provider-header")).toBeHidden();
    await expect(page.locator('[name="draft-consent"]')).toBeChecked();
    await separated();
    if (width === 390) await page.screenshot({ path: "/Users/jw/Desktop/Cosmas/Scribe-patient-ready-validation-20261109/draft-consent-layout.png", fullPage: true });
    await page.evaluate(() => window.dobLab.releaseOpen());
    await expect(page.locator('[name="consent"]')).toBeChecked();
    await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
    const consent = await page.locator('[name="consent"]').boundingBox();
    const record = await page.getByRole("button", { name: "Start recording", exact: true }).boundingBox();
    expect(record.y).toBeGreaterThanOrEqual(consent.y + consent.height + 4);
  });
}
