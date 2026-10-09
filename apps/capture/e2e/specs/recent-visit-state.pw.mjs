/* global window */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

const row = page => page.locator(".provider-encounters li").first();
const status = page => row(page).locator(".provider-visit-status");
async function start(page) {
  await page.addInitScript(() => {
    window.recentMediaCalls = 0;
    for (const name of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, name,
      { value: () => { window.recentMediaCalls++; throw new Error("Real media forbidden"); } });
  });
  await page.goto("/e2e/fixtures/optional-dob.html?platform=ios&recents");
  await row(page).getByRole("button").click();
  await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
}
async function list(page) { await page.getByRole("button", { name: "Your encounters", exact: true }).click(); await expect(row(page)).toBeVisible(); }
async function reopen(page) { await row(page).getByRole("button").click(); await expect(page.locator("cosmaneura-capture")).toBeVisible(); }
async function pause(page, native = { phase: "paused", busy: false }, statusCode = "capture_paused") {
  await page.evaluate(({ native, statusCode }) => window.dobLab.emit({ state: "paused", native, statusCode, recordedChunks: 1 }), { native, statusCode });
}

test("recent visits reject unsettled stop, start and error labels while preserving a confirmed pause", async ({ page }) => {
  await start(page);
  await pause(page, { phase: "stopPending", busy: true }); await list(page); await expect(status(page)).toHaveCount(0);
  await reopen(page); await pause(page); await list(page); await expect(status(page)).toHaveText("Paused");
  await reopen(page);
  await page.evaluate(() => window.dobLab.emit({ state: "ready", statusCode: "capture_starting", native: { phase: "starting", busy: true } }));
  await list(page); await expect(status(page)).toHaveCount(0);
  await reopen(page); await pause(page);
  await page.evaluate(() => window.dobLab.emit({ state: "error", statusCode: "capture_interrupted", native: { phase: "failed", busy: false } }));
  await list(page); await expect(status(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.recentMediaCalls)).toBe(0);
  expect(await page.evaluate(() => window.dobLab.listCalls)).toBe(5);
});

test("late events cannot change listed visits and removed catalog access drops old observations", async ({ page }) => {
  await start(page); await pause(page); await list(page); await expect(status(page)).toHaveText("Paused");
  await page.evaluate(() => window.dobLab.emit({ state: "recording", statusCode: "capture_recording", native: { phase: "recording", busy: false } }));
  await page.getByRole("button", { name: "Refresh encounters", exact: true }).click(); await expect(status(page)).toHaveText("Paused");
  await page.evaluate(() => { window.savedCatalog = window.dobLab.catalog; window.dobLab.catalog = []; });
  await page.getByRole("button", { name: "Refresh encounters", exact: true }).click(); await expect(row(page)).toHaveCount(0);
  await page.evaluate(() => { window.dobLab.catalog = window.savedCatalog; });
  await page.getByRole("button", { name: "Refresh encounters", exact: true }).click(); await expect(row(page)).toBeVisible(); await expect(status(page)).toHaveCount(0);
  await page.evaluate(() => window.dobLab.signOut()); await expect(page.locator("#provider")).toBeEmpty();
});

test("accepted upload shows Processing and an authoritative draft takes precedence", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    window.dobLab.reviewStatus = "processing";
    window.dobLab.emit({ state: "processing", statusCode: "capture_processing", native: { phase: "completed", busy: false } });
  });
  await list(page); await expect(status(page)).toHaveText("Processing");
  await page.evaluate(() => { window.dobLab.catalog = window.dobLab.catalog.map(row => ({ ...row, status: "draft_ready" })); });
  await page.getByRole("button", { name: "Refresh encounters", exact: true }).click(); await expect(status(page)).toHaveText("Draft ready");
  expect(await page.evaluate(() => window.dobLab.listCalls)).toBe(3);
});

test("a freshly verified note projects Draft ready without an extra catalog request", async ({ context, page, baseURL }) => {
  const server = await installNoteServer(context, { loseSaveResponse: false, origin: baseURL });
  await page.goto("/e2e/fixtures/provider-note.html");
  await page.locator(`[data-appointment="${server.scope.appointmentRef}"]`).click();
  await page.getByRole("button", { name: "Review draft note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toBeVisible();
  await list(page); await expect(status(page)).toHaveText("Draft ready"); server.assertHealthy();
});
