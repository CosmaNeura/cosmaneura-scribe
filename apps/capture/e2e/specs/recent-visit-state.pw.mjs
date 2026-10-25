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
  await row(page).locator('[data-workspace-action="open"]').click();
  const consent = page.getByRole("checkbox", { name: "The patient said yes", exact: true });
  const record = page.getByRole("button", { name: "Start recording", exact: true });
  await expect(consent).not.toBeChecked();
  await expect(record).toBeDisabled();
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
  await consent.click();
  await expect(record).toBeEnabled();
  await record.click();
  await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
}
async function unconfirmed(page) {
  await expect(status(page)).toHaveText("Not started");
  await expect(status(page)).toHaveAttribute("data-tone", "quiet");
  await expect(row(page).getByRole("button", { name: "Start", exact: true })).toHaveAttribute("data-workspace-action", "open");
  await expect(row(page).getByRole("button", { name: /Resume|Open note/ })).toHaveCount(0);
}
async function confirmedPause(page) {
  await expect(status(page)).toHaveText("Paused — visit not finished");
  await expect(status(page)).toHaveAttribute("data-tone", "paused");
  await expect(row(page).getByRole("button", { name: "Resume", exact: true })).toHaveAttribute("data-workspace-action", "open");
}
async function noteReady(page) {
  await expect(status(page)).toHaveText("Note ready");
  await expect(status(page)).toHaveAttribute("data-tone", "ready");
  await expect(row(page).getByRole("button", { name: "Open note", exact: true })).toHaveAttribute("data-workspace-action", "open-draft");
}
async function oneRecordingOnly(page) {
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts, window.recentMediaCalls])).toEqual([1, 1, 0]);
}
async function catalogPoll(page, delayMs) {
  const before = await page.evaluate(() => window.dobLab.listCalls);
  await page.clock.fastForward(delayMs);
  await expect.poll(() => page.evaluate(() => window.dobLab.listCalls)).toBe(before + 1);
}
async function list(page) { await page.getByRole("button", { name: "Back to encounters", exact: true }).click(); await expect(row(page)).toBeVisible(); }
async function reopen(page) { await row(page).locator('[data-workspace-action="open"]').click(); await expect(page.locator("cosmaneura-capture")).toBeVisible(); }
async function pause(page, native = { phase: "paused", busy: false }, statusCode = "capture_paused") {
  await page.evaluate(({ native, statusCode }) => window.dobLab.emit({ state: "paused", native, statusCode, recordedChunks: 1 }), { native, statusCode });
}

test("recent visits reject unsettled stop, start and error labels while preserving a confirmed pause", async ({ page }) => {
  await start(page);
  await pause(page, { phase: "stopPending", busy: true }); await list(page); await unconfirmed(page);
  await reopen(page); await pause(page); await list(page); await confirmedPause(page);
  await reopen(page);
  await page.evaluate(() => window.dobLab.emit({ state: "ready", statusCode: "capture_starting", native: { phase: "starting", busy: true } }));
  await list(page); await unconfirmed(page);
  await reopen(page); await pause(page);
  await page.evaluate(() => window.dobLab.emit({ state: "error", statusCode: "capture_interrupted", native: { phase: "failed", busy: false } }));
  await list(page); await unconfirmed(page);
  await oneRecordingOnly(page);
  expect(await page.evaluate(() => window.dobLab.listCalls)).toBe(5);
});

test("late events cannot change listed visits and removed catalog access drops old observations", async ({ page }) => {
  await page.clock.install();
  await start(page); await pause(page); await list(page); await confirmedPause(page);
  await page.evaluate(() => window.dobLab.emit({ state: "recording", statusCode: "capture_recording", native: { phase: "recording", busy: false } }));
  // The current patient list refreshes automatically, without a manual Refresh control.
  await catalogPoll(page, 30_000); await confirmedPause(page);
  await page.evaluate(() => { window.savedCatalog = window.dobLab.catalog; window.dobLab.catalog = []; });
  await catalogPoll(page, 30_000); await expect(row(page)).toHaveCount(0);
  await page.evaluate(() => { window.dobLab.catalog = window.savedCatalog; });
  await catalogPoll(page, 30_000); await expect(row(page)).toBeVisible(); await unconfirmed(page);
  await oneRecordingOnly(page);
  await page.evaluate(() => window.dobLab.signOut()); await expect(page.locator("#provider")).toBeEmpty();
});

test("accepted upload waits without an action and an authoritative note takes precedence", async ({ page }) => {
  await page.clock.install();
  await start(page);
  await page.evaluate(() => {
    window.dobLab.reviewStatus = "processing";
    window.dobLab.emit({ state: "processing", statusCode: "capture_processing", native: { phase: "completed", busy: false } });
  });
  await list(page); await expect(status(page)).toHaveText("Preparing your visit…");
  await expect(status(page)).toHaveAttribute("data-tone", "waiting");
  await expect(row(page).getByRole("button")).toHaveCount(0);
  await page.evaluate(() => { window.dobLab.catalog = window.dobLab.catalog.map(row => ({ ...row, status: "draft_ready" })); });
  await catalogPoll(page, 3000); await noteReady(page);
  await oneRecordingOnly(page);
  expect(await page.evaluate(() => window.dobLab.listCalls)).toBe(3);
});

test("a freshly verified note projects Note ready during one catalog refresh", async ({ context, page, baseURL }) => {
  const server = await installNoteServer(context, { loseSaveResponse: false, origin: baseURL });
  await page.goto("/e2e/fixtures/provider-note.html");
  await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
  await page.getByRole("button", { name: "Review draft note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toBeVisible();
  const before = await page.evaluate(() => window.noteLab.listCalls);
  await list(page); await noteReady(page);
  expect(await page.evaluate(() => window.noteLab.listCalls)).toBe(before + 1);
  server.assertHealthy();
});
