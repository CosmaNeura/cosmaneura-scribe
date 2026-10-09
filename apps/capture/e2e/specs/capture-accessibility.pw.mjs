import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { CapturePage } from "../pages/capture-page.mjs";

test("synthetic capture setup has no automatically detectable WCAG A/AA violations", async ({ page }) => {
  await new CapturePage(page).open("idle");
  await test.step("accessibility", async () => {
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    // Never attach raw DOM, page content, or axe's HTML node excerpts.
    const violations = result.violations.map(({ id, impact, nodes }) => ({ id, impact, count: nodes.length }));
    expect(violations).toEqual([]);
  });
});
