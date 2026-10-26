/* global window, document, getComputedStyle, NodeFilter */
import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const menu = page => page.locator(".provider-account-menu");
const account = page => menu(page).locator("summary");
const open = async (page, query = "") => {
  await page.goto(`/e2e/fixtures/provider-account.html${query}`);
  await expect(page.getByRole("heading", { name: "Today's patients", exact: true })).toBeVisible();
};
const rectangle = locator => locator.boundingBox();

for (const [width, height, textScale] of [[320, 568, 1], [390, 844, 1], [402, 874, 1], [480, 332, 1], [320, 568, 2], [480, 332, 2], [480, 332, 3]]) {
  test(`Account stays above the page and Sign out remains reachable at ${width}×${height}, text ${textScale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await open(page, "?long");
    if (textScale > 1) await page.addStyleTag({ content: `html { font-size:${100 * textScale}%; }` });
    const header = page.locator(".provider-session-header"), workflow = page.locator("[data-provider-workflow]");
    const before = { header: await rectangle(header), workflow: await rectangle(workflow) };
    await account(page).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await rectangle(header)).toEqual(before.header);
    expect(await rectangle(workflow)).toEqual(before.workflow);
    const panel = await rectangle(page.locator(".provider-account-panel"));
    const signOut = await rectangle(page.getByRole("button", { name: "Sign out", exact: true }));
    expect(signOut.y + signOut.height).toBeLessThanOrEqual(panel.y + panel.height);
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath("account-open.png") });
  });
}

test("Account text and actions have readable contrast and touch targets", async ({ page }) => {
  await open(page);
  await account(page).click();
  const samples = await page.locator(".provider-account-panel").evaluate(panel => {
    const luminance = css => {
      const rgb = css.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    return [...panel.querySelectorAll("p, button, a")].map(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      const bg = style.backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(panel).backgroundColor : style.backgroundColor;
      const colors = [luminance(style.color), luminance(bg)].sort((a, b) => b - a);
      return { contrast: (colors[0] + .05) / (colors[1] + .05), action: element.matches("a,button"), height: rect.height };
    });
  });
  for (const sample of samples) {
    expect(sample.contrast).toBeGreaterThanOrEqual(4.5);
    if (sample.action) expect(sample.height).toBeGreaterThanOrEqual(44);
  }
});

test("opening Account remeasures its viewport position and keeps long identity scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 332 });
  await open(page, "?long");
  // Move the header without resizing it; an old height observation is insufficient.
  await page.addStyleTag({ content: "#provider { margin-top:80px; }" });
  await account(page).click();
  const panel = page.locator(".provider-account-panel");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeInViewport({ ratio: 1 });
  const bounds = await rectangle(panel);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(332);
  await panel.hover();
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 900);
  await expect(page.getByRole("link", { name: "Get help", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeInViewport({ ratio: 1 });
});

test("keyboard and outside interaction close Account without trapping focus", async ({ page }) => {
  await open(page);
  await account(page).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeFocused();
  await page.evaluate(() => window.accountLab.poll());
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).not.toHaveAttribute("open", "");
  await expect(account(page)).toBeFocused();
  await account(page).click();
  await page.locator(".provider-brand strong").click();
  await expect(menu(page)).not.toHaveAttribute("open", "");
  await account(page).click();
  await page.getByRole("button", { name: "Previous day", exact: true }).focus();
  await expect(menu(page)).not.toHaveAttribute("open", "");
});

test("visible workspace, account, and signed-out lettering remain readable", async ({ page }, testInfo) => {
  await open(page);
  const samples = [];
  const scan = async surface => {
    const found = await page.locator("#provider").evaluate(root => {
      const luminance = css => {
        const rgb = css.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const result = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const element = node.parentElement, text = node.textContent.trim();
        if (!text || element.closest('svg, [aria-hidden="true"], :disabled') || !element.checkVisibility()) continue;
        const style = getComputedStyle(element);
        let backgrounds = [];
        for (let parent = element; parent && !backgrounds.length; parent = parent.parentElement) {
          const background = getComputedStyle(parent);
          if (background.backgroundImage.startsWith("linear-gradient")) backgrounds = background.backgroundImage.match(/rgb\([^)]+\)/g) ?? [];
          else if (background.backgroundColor !== "rgba(0, 0, 0, 0)") backgrounds = [background.backgroundColor];
        }
        const contrasts = backgrounds.map(background => {
          const colors = [luminance(style.color), luminance(background)].sort((a, b) => b - a);
          return (colors[0] + .05) / (colors[1] + .05);
        });
        result.push({ text, color: style.color, backgrounds, contrast: Math.min(...contrasts) });
      }
      return result;
    });
    expect(found.length).toBeGreaterThan(2);
    for (const sample of found) {
      expect(sample.backgrounds.length, sample.text).toBeGreaterThan(0);
      expect(sample.contrast, sample.text).toBeGreaterThanOrEqual(4.5);
    }
    samples.push({ surface, samples: found });
  };
  await scan("workspace");
  await account(page).click();
  await scan("account");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await scan("signed-out");
  const path = testInfo.outputPath("computed-text-contrast.json");
  await writeFile(path, JSON.stringify(samples, null, 2));
  await testInfo.attach("computed-text-contrast.json", { path, contentType: "application/json" });
});

test("Sign out closes the workspace immediately and returns to normal sign-in", async ({ page }) => {
  await open(page, "?pending");
  await account(page).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("[data-provider-workflow]")).toBeEmpty();
  await expect.poll(() => page.evaluate(() => window.accountLab.stats.signOutCalls)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.accountLab.stats.aborts)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.accountLab.stats.disposals)).toBe(1);
  await page.evaluate(() => window.accountLab.releaseSignOut());
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(menu(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today's patients", exact: true })).toBeVisible();
  await account(page).click();
  await expect(menu(page)).toContainText("Dr. Morgan Reed");
  expect(await page.evaluate(() => window.accountLab.stats)).toEqual({ signOutCalls: 1, signInCalls: 1, connections: 2, disposals: 1, aborts: 1, sourceCalls: 0 });
});

test("unconfirmed SDK sign-out keeps the workspace closed and exposes normal retry", async ({ page }) => {
  await open(page, "?fail-once");
  await account(page).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry sign out", exact: true })).toBeEnabled();
  await expect(page.locator("[data-provider-workflow]")).toBeEmpty();
  await page.getByRole("button", { name: "Retry sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.accountLab.stats.signOutCalls)).toBe(2);
  expect(await page.evaluate(() => window.accountLab.stats.sourceCalls)).toBe(0);
});
