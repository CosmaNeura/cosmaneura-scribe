/* global document: readonly, innerWidth: readonly, window: readonly */
// Optional local interaction rehearsal. Identity/native storage/Core are explicit fixtures.
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL(process.env.SCRIBE_PLAYWRIGHT_MODULE).href);
const { expect } = await import(pathToFileURL(process.env.SCRIBE_PLAYWRIGHT_TEST_MODULE).href);
const [origin, decision, output] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error("Loopback trial required");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: decision === "accepted"
    ? { width: 1280, height: 1000 } : { width: 390, height: 844 } });
  const failures = [];
  page.on("pageerror", () => failures.push("page_error"));
  await page.goto(origin);
  await expect(page.getByText("Recording uploaded", { exact: true })).toBeVisible();
  await page.request.post(`${origin}/trial/process`);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Translation result unconfirmed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept English translation" })).toHaveCount(0);
  await page.screenshot({ path: `${output}/${decision}-unconfirmed.png`, fullPage: true });
  await page.request.post(`${origin}/trial/finish-translation`);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("No tengo fiebre.", { exact: true })).toBeVisible();
  await expect(page.getByText("I am not sure when it started.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to note" })).toHaveCount(0);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Horizontal overflow");
  await page.screenshot({ path: `${output}/${decision}-review.png`, fullPage: true });
  await page.getByRole("button", { name: decision === "accepted" ? "Accept English translation" : "Reject translation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry the same decision" })).toBeVisible();
  await expect(page.getByText("No tengo fiebre.", { exact: true })).toHaveCount(0);
  // Actual document loss: a new component, API client and journal adapter recover from disk.
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry the same decision" })).toBeVisible();
  await page.getByRole("button", { name: "Retry the same decision" }).click();
  if (decision === "accepted") {
    await expect(page.getByText("English transcript ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue to note" }).click();
    await expect(page.getByText("Core entry requested (fixture)", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByText(/The translation was rejected/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to note" })).toHaveCount(0);
  }
  await page.screenshot({ path: `${output}/${decision}-resolved.png`, fullPage: true });
  await page.request.post(`${origin}/trial/revoke`);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/This recording is unavailable/)).toBeVisible();
  await expect(page.getByText("No tengo fiebre.", { exact: true })).toHaveCount(0);
  await page.evaluate((rejectStop) => {
    window.failFixtureDeactivation = rejectStop;
    window.endFixtureBinding();
  }, decision === "rejected");
  await expect(page.getByText(decision === "rejected" ? /Recording stop could not be confirmed/ : /Recording closed/)).toBeVisible();
  if (failures.length) throw new Error("Browser script failed");
  process.stdout.write(JSON.stringify({ decision, reload_recovered: true, revoked_cleared: true }) + "\n");
} finally { await browser.close(); }
