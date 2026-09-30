/* global window */
import { expect, test } from "../../capture/e2e/node_modules/@playwright/test/index.mjs";

for (const width of [390, 900]) {
  test(`search and explicit correction preserve source at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/e2e/creator-edit.html");
    await expect(page.getByText("Needs accuracy review.", { exact: false })).toBeVisible();
    await expect(page.getByText("Review is complete", { exact: false })).toHaveCount(0);
    await page.getByLabel("Find in transcript").fill("sintoma");
    await expect(page.locator("[data-transcript-segment]:visible")).toHaveCount(1);
    await expect(page.getByText("1 matching turn", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.locator("[data-transcript-segment]:visible")).toHaveCount(2);
    await page.getByRole("button", { name: "Correct wording or speaker" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("English wording").fill("Synthetic corrected clinician asks about fictional left wrist soreness.");
    await dialog.getByRole("combobox", { name: "Speaker", exact: true }).selectOption("clinician");
    await dialog.getByLabel("Name (optional)").fill("Fictional Dr. Avery");
    await dialog.getByRole("button", { name: "Save correction" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Provider · Fictional Dr. Avery · confirmed", { exact: true })).toBeVisible();
    await expect(page.getByText("English · corrected", { exact: true })).toBeVisible();
    await expect(page.getByText("Spanish · original", { exact: true })).toBeVisible();
    await page.getByText("Original wording", { exact: true }).click();
    await expect(page.getByText("Synthetic clinician asks about fictional wrist soreness.", { exact: true })).toBeVisible();
    const state = await page.evaluate(() => ({ view: window.creatorEditLab.view, pending: window.creatorEditLab.pending, requests: window.creatorEditLab.requests }));
    expect(state.view.source.segments[0].content).toBe("Synthetic clinician asks about fictional wrist soreness.");
    expect(state.view.review_edits).toHaveLength(1);
    expect(state.pending).toBeNull();
    expect(state.requests).toHaveLength(1);
    await page.screenshot({ path: info.outputPath("corrected-transcript.png"), fullPage: true });
  });
}

test("uncertain edit keeps one exact operation and retries its receipt", async ({ page }) => {
  await page.goto("/e2e/creator-edit.html?lost");
  await page.getByRole("button", { name: "Correct wording or speaker" }).first().click();
  await page.getByLabel("English wording").fill("Synthetic recovery check.");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("The correction save is unconfirmed.", { exact: false })).toBeVisible();
  await expect(page.getByText("Synthetic recovery check.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check correction save" }).click();
  await expect(page.getByText("English · corrected", { exact: true })).toBeVisible();
  const state = await page.evaluate(() => ({ requests: window.creatorEditLab.requests, history: window.creatorEditLab.view.review_edits, pending: window.creatorEditLab.pending }));
  expect(state.requests).toHaveLength(2);
  expect(state.requests[0]).toEqual(state.requests[1]);
  expect(state.history).toHaveLength(1);
  expect(state.pending).toBeNull();
});
