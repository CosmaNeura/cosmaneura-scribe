/* global document, innerWidth */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const loseSaveResponse of [false, true]) {
    test(`saved note survives relaunch at ${viewport.width}px; lost response=${loseSaveResponse}`, async ({ context, page }) => {
      await context.addInitScript(() => {
        globalThis.__noteLabMediaCalls = 0;
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: () => {
          globalThis.__noteLabMediaCalls += 1; throw new Error("No media in note rehearsal");
        } });
      });
      const server = await installNoteServer(context, { loseSaveResponse });
      const openVisit = async target => {
        await target.setViewportSize(viewport);
        await target.goto("/e2e/fixtures/provider-note.html");
        await target.locator(`[data-appointment="${server.scope.appointmentRef}"]`).click();
      };
      const openNote = async target => {
        await target.getByRole("button", { name: "Continue to note", exact: true }).click();
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
        await expect(page.getByText(loseSaveResponse ? "Confirm your previous save" : "Draft saved. Clinical review is still required.", { exact: true })).toBeVisible();
      });
      expect(server.calls.filter(call => call === "save")).toHaveLength(1);
      expect(await page.evaluate(() => globalThis.__noteLabMediaCalls)).toBe(0);
      await page.close({ runBeforeUnload: false });
      const relaunched = await context.newPage();
      await test.step("note_reopen", async () => {
        await openVisit(relaunched);
        if (loseSaveResponse) {
          await expect(relaunched.getByRole("button", { name: "Check save status", exact: true })).toBeVisible();
          expect(server.calls.filter(call => call === "resolve")).toHaveLength(0);
          await test.step("note_recover", async () => {
            await relaunched.getByRole("button", { name: "Check save status", exact: true }).click();
            await expect(relaunched.getByText("Previous save confirmed. Your saved draft is shown.", { exact: true })).toBeVisible();
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
      expect(server.calls.filter(call => call === "resolve")).toHaveLength(loseSaveResponse ? 1 : 0);
      expect(server.current().review_required).toBe(true);
      expect(server.current().note_ref).not.toBe(server.original.note_ref);
      expect(server.original.fields.Patient).toBe("Invented patient — no real patient.");
      expect(await relaunched.evaluate(() => globalThis.__noteLabMediaCalls)).toBe(0);
      expect(await relaunched.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      server.assertHealthy();
    });
  }
}
