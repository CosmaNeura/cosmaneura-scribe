/* global document, innerWidth */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const loseSaveResponse of [false, true]) {
    test(`saved note survives relaunch at ${viewport.width}px; lost response=${loseSaveResponse}`, async ({ context, page, baseURL }) => {
      await context.addInitScript(() => {
        globalThis.__noteLabMediaCalls = 0;
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: () => {
          globalThis.__noteLabMediaCalls += 1; throw new Error("No media in note rehearsal");
        } });
      });
      const server = await installNoteServer(context, { loseSaveResponse, origin: baseURL, statusPending: loseSaveResponse });
      const openVisit = async target => {
        await target.setViewportSize(viewport);
        await target.goto("/e2e/fixtures/provider-note.html");
        await target.locator(`[data-appointment="${server.scope.appointmentRef}"]`).click();
      };
      const openNote = async target => {
        await target.getByRole("button", { name: /^(Continue to note|Review draft note)$/u }).click();
        await expect(target.getByRole("textbox", { name: "Patient", exact: true })).toBeVisible();
      };
      await test.step("note_open", async () => { await openVisit(page); await openNote(page); });
      const edited = "SYNTHETIC ACCEPTANCE — exact saved edit\nAvery’s fictional visit; no real patient.";
      await page.getByRole("textbox", { name: "Patient", exact: true }).fill(edited);
      await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();
      // A reduced mobile viewport exercises the save bar while the clinician
      // is editing farther down the note. Physical keyboard behavior is separate.
      if (viewport.width === 390) await page.setViewportSize({ width: 390, height: 430 });
      await page.getByRole("textbox", { name: "Plan", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeInViewport();
      await test.step("note_save", async () => {
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        await expect(page.locator("[data-note-save-state]")).toHaveText(loseSaveResponse ? "Save confirmation pending · Edits retained" : "Saved · Not clinically reviewed");
      });
      expect(server.calls.filter(call => call === "save")).toHaveLength(1);
      expect(await page.evaluate(() => globalThis.__noteLabMediaCalls)).toBe(0);
      await page.close({ runBeforeUnload: false });
      server.releaseStatus();
      const relaunched = await context.newPage();
      await test.step("note_reopen", async () => {
        await openVisit(relaunched);
        if (loseSaveResponse) {
          await test.step("note_recover", async () => {
            await expect(relaunched.locator("[data-note-save-state]")).toHaveText("Saved · Not clinically reviewed");
            expect(server.calls.filter(call => call === "resolve")).toHaveLength(0);
          });
        } else await openNote(relaunched);
        await expect(relaunched.getByRole("textbox", { name: "Patient", exact: true })).toHaveValue(edited);
        await expect(relaunched.getByRole("textbox", { name: "Plan", exact: true })).toHaveValue(server.original.fields.Plan);
        await relaunched.getByRole("button", { name: "Your encounters", exact: true }).click();
        await relaunched.locator(`[data-appointment="${server.scope.appointmentRef}"]`).click();
        await openNote(relaunched);
        await expect(relaunched.getByRole("textbox", { name: "Patient", exact: true })).toHaveValue(edited);
      });
      expect(server.calls.filter(call => call === "save")).toHaveLength(1);
      expect(server.calls.filter(call => call === "resolve")).toHaveLength(0);
      expect(server.current().review_required).toBe(true);
      expect(server.current().note_ref).not.toBe(server.original.note_ref);
      expect(server.original.fields.Patient).toBe("Invented patient — no real patient.");
      expect(await relaunched.evaluate(() => globalThis.__noteLabMediaCalls)).toBe(0);
      expect(await relaunched.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      server.assertHealthy();
    });
  }
}

for (const width of [1280, 390]) {
  test(`draft completing after 96 seconds appears without refresh at ${width}px`, async ({ context, page, baseURL }) => {
    await context.addInitScript(() => {
      globalThis.__noteLabMediaCalls = 0;
      for (const method of ["getUserMedia", "getDisplayMedia"]) {
        Object.defineProperty(navigator.mediaDevices, method, { value: () => {
          globalThis.__noteLabMediaCalls += 1; throw new Error("No media in late-note rehearsal");
        } });
      }
    });
    await page.setViewportSize({ width, height: 844 });
    await page.clock.install({ time: new Date() });
    const server = await installNoteServer(context, { origin: baseURL, draftPending: true,
      clockNow: () => page.evaluate(() => new Date().toISOString()) });
    await page.goto("/e2e/fixtures/provider-note.html");
    await page.locator(`[data-appointment="${server.scope.appointmentRef}"]`).click();
    await page.getByRole("button", { name: "Review draft note", exact: true }).click();
    await page.getByRole("button", { name: "Prepare draft note", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Waiting for your draft note…", exact: true })).toBeVisible();
    await expect(page.locator("[data-note-readiness]")).toContainText("You do not need to refresh.");
    await page.clock.fastForward(96_000);
    await expect(page.locator("[data-note-wait-time]")).toContainText("Checking automatically");
    server.releaseDraft();
    await page.clock.runFor(4_000);
    await expect(page.getByRole("textbox", { name: "Patient", exact: true })).toHaveValue(server.original.fields.Patient);
    expect(server.calls.filter(call => call === "prepare")).toHaveLength(1);
    expect(await page.evaluate(() => globalThis.__noteLabMediaCalls)).toBe(0);
    server.assertHealthy();
  });
}
