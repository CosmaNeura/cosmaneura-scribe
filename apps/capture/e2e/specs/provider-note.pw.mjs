/* global document, innerWidth */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const loseSaveResponse of [false, true]) {
    test(`autosaved note survives relaunch at ${viewport.width}px; lost response=${loseSaveResponse}`, async ({ context, page, baseURL }) => {
      await context.addInitScript(() => {
        globalThis.__noteLabMediaCalls = 0;
        for (const method of ["getUserMedia", "getDisplayMedia"]) {
          Object.defineProperty(navigator.mediaDevices, method, { value: () => {
            globalThis.__noteLabMediaCalls += 1; throw new Error("No media in note rehearsal");
          } });
        }
      });
      const server = await installNoteServer(context, { loseSaveResponse, origin: baseURL, statusPending: loseSaveResponse });
      const openVisit = async target => {
        await target.setViewportSize(viewport);
        await target.goto("/e2e/fixtures/provider-note.html?dashboard-review");
        await target.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
      };
      const openNote = async target => {
        await target.getByRole("button", { name: /^(Continue to note|Review draft note)$/u }).click();
        await target.locator("[data-note-section-group] > summary").click();
        await target.locator('[data-note-section="0"] > summary').click();
        await expect(target.getByRole("textbox", { name: "Patient", exact: true })).toBeVisible();
      };
      await test.step("note_open", async () => { await openVisit(page); await openNote(page); });
      const edited = "SYNTHETIC ACCEPTANCE — exact saved edit\nAvery’s fictional visit; no real patient.";
      await page.getByRole("textbox", { name: "Patient", exact: true, includeHidden: true }).fill(edited);
      await expect(page.locator("[data-note-save-state]")).toHaveText("Draft saving…");
      await test.step("automatic_save", async () => {
        await expect(page.locator("[data-note-save-state]")).toHaveText(loseSaveResponse
          ? "Draft save not confirmed" : /^Draft saved at /u);
        expect(server.calls.filter(call => call === "save")).toHaveLength(1);
        await expect(page.getByRole("textbox", { name: "Patient", exact: true, includeHidden: true })).toHaveValue(edited);
        expect(await page.evaluate(() => globalThis.noteLab.dashboardNoteRefs)).toEqual([]);
      });
      // A reduced mobile viewport exercises the save bar while the clinician
      // is editing farther down the note. Physical keyboard behavior is separate.
      if (viewport.width === 390) await page.setViewportSize({ width: 390, height: 430 });
      await page.getByRole("textbox", { name: "Plan", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Save and review", exact: true })).toBeInViewport();
      await test.step("review_navigation_requires_confirmed_save", async () => {
        await page.getByRole("button", { name: "Save and review", exact: true }).click();
        if (loseSaveResponse) {
          await expect(page.locator("[data-note-save-state]")).toHaveText("Draft save not confirmed");
          await expect(page.getByRole("heading", { name: "Saved for review", exact: true })).toHaveCount(0);
          expect(await page.evaluate(() => globalThis.noteLab.dashboardNoteRefs)).toEqual([]);
        } else {
          await expect(page.getByRole("heading", { name: "Saved for review", exact: true })).toBeVisible();
          expect(await page.evaluate(() => globalThis.noteLab.dashboardNoteRefs)).toEqual([]);
          await page.getByRole("button", { name: "Open the dashboard", exact: true }).click();
          expect(await page.evaluate(() => globalThis.noteLab.dashboardNoteRefs)).toEqual([server.current().note_ref]);
        }
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
            await expect(relaunched.locator("[data-note-save-state]")).toHaveText(/^Draft saved at /u);
            expect(server.calls.filter(call => call === "resolve")).toHaveLength(0);
          });
        } else await openNote(relaunched);
        await expect(relaunched.getByRole("textbox", { name: "Patient", exact: true, includeHidden: true })).toHaveValue(edited);
        await expect(relaunched.getByRole("textbox", { name: "Plan", exact: true })).toHaveValue(server.original.fields.Plan);
        await relaunched.getByRole("button", { name: "Back to encounters", exact: true }).click();
        const savedRow = relaunched.locator(`[data-visit-ref="${server.scope.appointmentRef}"]`);
        await expect(savedRow.getByText("Note ready", { exact: true })).toBeVisible();
        const openingReads = server.calls.filter(call => call === "note-opening").length;
        await savedRow.getByRole("button", { name: "Open note", exact: true }).click();
        await expect(relaunched.getByRole("textbox", { name: "Patient", exact: true, includeHidden: true })).toHaveValue(edited);
        expect(server.calls.filter(call => call === "note-opening")).toHaveLength(openingReads + 1);
        expect(await relaunched.evaluate(() => globalThis.noteLab.openRefs)).toEqual([server.scope.appointmentRef, server.scope.appointmentRef]);
      });
      await relaunched.getByRole("button", { name: "Save and review", exact: true }).click();
      await expect(relaunched.getByRole("heading", { name: "Saved for review", exact: true })).toBeVisible();
      expect(await relaunched.evaluate(() => globalThis.noteLab.dashboardNoteRefs)).toEqual([]);
      await relaunched.getByRole("button", { name: "Open the dashboard", exact: true }).click();
      expect(await relaunched.evaluate(() => globalThis.noteLab.dashboardNoteRefs)).toEqual([server.current().note_ref]);
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
    await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
    await page.getByRole("button", { name: "Review draft note", exact: true }).click();
    await page.getByRole("button", { name: "Write visit note", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Recording saved", exact: true })).toBeVisible();
    await expect(page.getByText("Writing your visit note…", { exact: true })).toBeVisible();
    await expect(page.locator("[data-note-readiness]")).toContainText("Your draft will appear here automatically when it is ready.");
    await page.clock.fastForward(96_000);
    await expect(page.locator("[data-note-wait-time]")).toContainText("Checking automatically");
    server.releaseDraft();
    await page.clock.runFor(4_000);
    await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toHaveValue(server.original.fields.Plan);
    expect(server.calls.filter(call => call === "prepare")).toHaveLength(1);
    expect(await page.evaluate(() => globalThis.__noteLabMediaCalls)).toBe(0);
    server.assertHealthy();
  });
}

// The visible cached status is only a route into a fresh authorized open. A
// retained DOM action cannot restore a ref removed or superseded by the catalog.
test("locally ready note actions reject foreign, superseded and removed catalog refs", async ({ context, page, baseURL }) => {
  await page.clock.install({ time: new Date() });
  const server = await installNoteServer(context, { origin: baseURL,
    clockNow: () => page.evaluate(() => new Date().toISOString()) });
  await page.goto("/e2e/fixtures/provider-note.html");
  await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
  await page.getByRole("button", { name: "Review draft note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to encounters", exact: true }).click();
  const row = page.locator(`[data-visit-ref="${server.scope.appointmentRef}"]`);
  await expect(row.getByRole("button", { name: "Open note", exact: true })).toBeVisible();
  await page.evaluate(() => {
    globalThis.retainedDraftButton = document.querySelector('[data-workspace-action="open-draft"]').cloneNode(true);
    const foreign = globalThis.retainedDraftButton.cloneNode(true);
    foreign.dataset.appointment = globalThis.noteLab.catalog[1].appointmentRef;
    document.querySelector("#provider").append(foreign); foreign.click(); foreign.remove();
  });
  expect(await page.evaluate(() => globalThis.noteLab.openRefs)).toEqual([server.scope.appointmentRef]);
  const freshCatalog = async () => {
    const reads = await page.evaluate(() => globalThis.noteLab.listCalls);
    await page.clock.fastForward(30_000);
    await expect.poll(() => page.evaluate(() => globalThis.noteLab.listCalls)).toBe(reads + 1);
  };
  await page.evaluate(() => { globalThis.noteLab.catalog = globalThis.noteLab.catalog.map(row => ({ ...row, status: "processing" })); });
  await freshCatalog();
  await expect(row.getByRole("button")).toHaveCount(0);
  const staleClick = () => page.evaluate(() => {
    const stale = globalThis.retainedDraftButton.cloneNode(true);
    document.querySelector("#provider").append(stale); stale.click(); stale.remove();
  });
  await staleClick();
  expect(await page.evaluate(() => globalThis.noteLab.openRefs)).toEqual([server.scope.appointmentRef]);
  await page.evaluate(() => { globalThis.noteLab.catalog = globalThis.noteLab.catalog.slice(1); });
  await freshCatalog();
  await expect(row).toHaveCount(0);
  await staleClick();
  expect(await page.evaluate(() => globalThis.noteLab.openRefs)).toEqual([server.scope.appointmentRef]);
  expect(server.calls.filter(call => call === "save" || call === "prepare")).toEqual([]);
  server.assertHealthy();
});
