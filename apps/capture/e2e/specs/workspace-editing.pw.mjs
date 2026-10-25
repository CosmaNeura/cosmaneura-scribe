/* global window */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

async function openDraft(page, server) {
  await page.goto("/e2e/fixtures/provider-note.html");
  await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
  await page.getByRole("button", { name: /^(Continue to note|Review draft note)$/u }).click();
  await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toBeVisible();
}

async function forbidMedia(page) {
  await page.addInitScript(() => {
    window.workspaceMediaCalls = 0;
    for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, method, { value: () => {
      window.workspaceMediaCalls++; throw new Error("Media is forbidden in virtual note tests");
    } });
  });
}

async function pauseAutosaveClock(page) {
  await page.clock.install({ time: new Date("2026-10-25T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-25T12:00:01Z"));
}

for (const viewport of [{ width: 1100, height: 800 }, { width: 390, height: 430 }]) {
  test(`unsaved decision stays visible and restores the actual editor at ${viewport.width}px`, async ({ context, page, baseURL }, testInfo) => {
    await forbidMedia(page); await page.setViewportSize(viewport);
    await pauseAutosaveClock(page);
    const server = await installNoteServer(context, { loseSaveResponse: false, origin: baseURL,
      clockNow: () => page.evaluate(() => new Date().toISOString()) });
    await openDraft(page, server);
    await page.screenshot({ path: testInfo.outputPath("draft-editor.png") });
    const plan = page.getByRole("textbox", { name: "Plan", exact: true });
    await plan.fill("Synthetic interrupted edit. No real patient.");
    await plan.focus();
    await plan.evaluate(field => { field.setSelectionRange(9, 20); window.savedEditorNode = field; });
    // Exercise navigation before the 750 ms autosave debounce. Showing the
    // conversation now intentionally keeps the same editor without a dialog.
    const refresh = page.getByRole("button", { name: "Refresh current visit", exact: true });
    await refresh.click();
    const dialog = page.getByRole("dialog", { name: "Keep your note edits?" });
    await expect(dialog).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("visible-unsaved-decision.png") });
    await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
    expect(server.calls.filter(call => ["save", "resolve", "save_status"].includes(call))).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(plan).toBeFocused();
    expect(await plan.evaluate(field => ({ same: field === window.savedEditorNode, start: field.selectionStart, end: field.selectionEnd })))
      .toEqual({ same: true, start: 9, end: 20 });
    await expect(plan).toHaveValue("Synthetic interrupted edit. No real patient.");
    await refresh.click();
    await page.getByRole("button", { name: "Save & continue", exact: true }).click();
    await expect(plan).not.toBeVisible();
    expect(server.calls.filter(call => call === "save")).toHaveLength(1);
    expect(server.current().fields.Plan).toBe("Synthetic interrupted edit. No real patient.");
    expect(await page.evaluate(() => window.workspaceMediaCalls)).toBe(0);
    server.assertHealthy();
  });

  test(`save preserves position and recovers a lost response without resubmitting at ${viewport.width}px`, async ({ context, page, baseURL }, testInfo) => {
    await forbidMedia(page); await page.setViewportSize(viewport);
    await pauseAutosaveClock(page);
    const server = await installNoteServer(context, { loseSaveResponse: true, origin: baseURL, saveDelayMs: 400,
      statusPending: true, clockNow: () => page.evaluate(() => new Date().toISOString()) });
    await openDraft(page, server);
    await page.screenshot({ path: testInfo.outputPath("draft-editor.png") });
    const plan = page.getByRole("textbox", { name: "Plan", exact: true });
    await plan.fill("Synthetic exact saved edit. No treatment plan discussed.");
    await plan.focus(); await plan.evaluate(field => { field.setSelectionRange(10, 15); window.savedEditorNode = field; });
    const before = await page.evaluate(() => window.scrollY);
    await expect(page.locator("[data-note-save-state]")).toHaveText("Draft saving…");
    expect(server.calls.filter(call => call === "save")).toHaveLength(0);
    await page.clock.runFor(750);
    await expect(page.locator("[data-note-save-state]")).toHaveText("Draft save not confirmed");
    await expect(plan).toHaveAttribute("readonly");
    await expect.poll(() => server.calls.filter(call => call === "save_status").length).toBeGreaterThan(0);
    expect(await plan.evaluate(field => ({ same: field === window.savedEditorNode, start: field.selectionStart, end: field.selectionEnd })))
      .toEqual({ same: true, start: 10, end: 15 });
    server.releaseStatus();
    await page.clock.runFor(2_000);
    await expect(page.locator("[data-note-save-state]")).toHaveText(/^Draft saved at /u);
    await expect(page.locator("[data-workspace-notice]")).toBeEmpty();
    expect(await plan.evaluate(field => ({ same: field === window.savedEditorNode, start: field.selectionStart, end: field.selectionEnd, readonly: field.readOnly })))
      .toEqual({ same: true, start: 10, end: 15, readonly: false });
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(2);
    await expect(plan).toBeFocused();
    expect(server.calls.filter(call => call === "save")).toHaveLength(1);
    expect(server.calls.filter(call => call === "save_status").length).toBeGreaterThan(0);
    expect(server.calls.filter(call => call === "resolve")).toHaveLength(0);
    await page.reload();
    await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
    await page.getByRole("button", { name: /^(Continue to note|Review draft note)$/u }).click();
    await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toHaveValue("Synthetic exact saved edit. No treatment plan discussed.");
    expect(await page.evaluate(() => window.workspaceMediaCalls)).toBe(0);
    server.assertHealthy();
  });
}

test("a pending save retains edits and offers manual recovery after automatic checking stops", async ({ context, page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 430 });
  await forbidMedia(page); await pauseAutosaveClock(page);
  const server = await installNoteServer(context, { loseSaveResponse: true, origin: baseURL, statusPending: true,
    clockNow: () => page.evaluate(() => new Date().toISOString()) });
  await openDraft(page, server);
  const plan = page.getByRole("textbox", { name: "Plan", exact: true });
  await plan.fill("Retained synthetic edit");
  await page.clock.runFor(750);
  await expect(page.locator("[data-note-save-state]")).toHaveText("Draft save not confirmed");
  await expect(page.locator("[data-note-save-state]")).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("pending-edit-retained.png") });
  // Background autosave preserves the editor's position. Deliberately scroll
  // to its recovery action instead of requiring autosave to move the reader.
  const check = page.getByRole("button", { name: "Check save status", exact: true });
  await check.scrollIntoViewIfNeeded(); await expect(check).toBeInViewport();
  expect((await check.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("pending-save-recovery.png") });
  await expect(page.locator("[data-workspace-notice]")).toBeEmpty();
  await expect(plan).toHaveValue("Retained synthetic edit");
  await expect(plan).toHaveAttribute("readonly");
  await expect.poll(() => server.calls.filter(call => call === "save_status").length).toBeGreaterThan(0);
  await page.clock.fastForward(31_000);
  const checks = server.calls.filter(call => call === "save_status").length;
  await page.clock.fastForward(10_000);
  expect(server.calls.filter(call => call === "save_status")).toHaveLength(checks);
  expect(server.calls.filter(call => call === "save")).toHaveLength(1);
  expect(server.calls.filter(call => call === "resolve")).toHaveLength(0);
  await expect(check).toBeVisible();
  server.releaseStatus(); await check.click();
  await expect(page.locator("[data-note-save-state]")).toHaveText(/^Draft saved at /u);
  await expect(plan).toHaveValue("Retained synthetic edit");
  await expect(plan).not.toHaveAttribute("readonly");
  expect(server.calls.filter(call => call === "save")).toHaveLength(1);
  expect(server.calls.filter(call => call === "resolve")).toHaveLength(1);
  server.assertHealthy();
});


test("phone conversation view retains unsaved edits without a save or remount", async ({ context, page, baseURL }) => {
  await forbidMedia(page); await page.setViewportSize({ width: 390, height: 600 });
  await pauseAutosaveClock(page);
  const server = await installNoteServer(context, { loseSaveResponse: false, origin: baseURL,
    clockNow: () => page.evaluate(() => new Date().toISOString()) });
  await openDraft(page, server);
  const plan = page.getByRole("textbox", { name: "Plan", exact: true });
  await plan.fill("Synthetic retained draft"); await plan.focus();
  await plan.evaluate(field => { window.savedEditorNode = field; field.setSelectionRange(2, 6); });
  await page.getByRole("button", { name: "Show the conversation", exact: true }).click();
  await expect(plan).not.toBeVisible();
  await expect(page.locator(".provider-note-evidence")).toBeVisible();
  await page.getByRole("button", { name: "Back to note", exact: true }).click();
  await expect(plan).toHaveValue("Synthetic retained draft");
  await expect(plan).toBeFocused();
  expect(await plan.evaluate(field => ({ same: field === window.savedEditorNode, start: field.selectionStart, end: field.selectionEnd })))
    .toEqual({ same: true, start: 2, end: 6 });
  expect(server.calls.filter(call => ["save", "resolve", "save_status"].includes(call))).toEqual([]);
  server.assertHealthy();
});
