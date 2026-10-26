/* global document, innerWidth, window, getComputedStyle */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

const longText = Array.from({ length: 45 }, (_, i) => `Synthetic observation ${i + 1}: the source speaker has not been identified. Do not infer a clinical role.`).join("\n");
const fields = { Subjective: "Source roles remain unidentified. Check the conversation.", Objective: longText,
  Assessment: "No clinician assessment attributed.", Plan: "No treatment plan discussed." };
const cases = [
  { viewport: { width: 402, height: 874 }, title: "Synthetic visit" },
  { viewport: { width: 402, height: 874 }, title: "Scribe Lab Synthetic Long Identity for Note Review 20261026" },
  { viewport: { width: 480, height: 332 }, title: "Scribe Lab Synthetic Long Identity for Note Review 20261026" },
  { viewport: { width: 320, height: 640 }, title: "Synthetic visit" },
  { viewport: { width: 390, height: 430 }, title: "Scribe Lab Synthetic Long Identity for Note Review 20261026", largeText: true, safeArea: true },
  { viewport: { width: 1280, height: 800 }, title: "Synthetic visit" },
];

for (const { viewport, title, largeText = false, safeArea = false } of cases) {
  test(`long note Save stays reachable ${viewport.width}x${viewport.height} ${title.length}chars large=${largeText}`, async ({ context, page, baseURL }, testInfo) => {
    await context.addInitScript(() => {
      globalThis.__noteLabMediaCalls = 0;
      for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, method, { value: () => {
        globalThis.__noteLabMediaCalls++; throw new Error("No media in note layout rehearsal");
      } });
    });
    const server = await installNoteServer(context, { origin: baseURL, fields, visitTitle: title, saveDelayMs: 350 });
    await page.setViewportSize(viewport);
    if (safeArea) {
      const devtools = await context.newCDPSession(page);
      await devtools.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 24, bottom: 34 } });
    }
    await page.goto("/e2e/fixtures/provider-note.html?dashboard-review");
    if (largeText) await page.addStyleTag({ content: "html { font-size:24px; }" });
    await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
    await page.getByRole("button", { name: "Review draft note", exact: true }).click();
    const save = page.getByRole("button", { name: "Save and review", exact: true });
    await expect(save).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("initial.png") });
    await testInfo.attach("initial-layout", { body: JSON.stringify(await save.boundingBox()), contentType: "application/json" });
    // No locator action may auto-scroll Save into view before this assertion.
    await expect(save).toBeInViewport({ ratio: 1 });
    const heading = page.getByRole("heading", { name: title, exact: true });
    await expect(heading).toBeInViewport({ ratio: 1 });
    const headingBox = await heading.boundingBox(), toolbarBox = await page.locator(".provider-note-actions").boundingBox();
    expect(headingBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);
    expect(await heading.evaluate(el => { const r = el.getBoundingClientRect();
      return [4, r.height / 2, r.height - 4].every(y => el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + y))); })).toBe(true);
    expect((await save.boundingBox()).height).toBeGreaterThanOrEqual(44);
    for (const [name, text] of Object.entries(fields)) await expect(page.getByRole("textbox", { name, exact: true })).toHaveValue(text);
    const objective = page.getByRole("textbox", { name: "Objective", exact: true });
    expect((await objective.boundingBox()).height).toBeGreaterThan(viewport.height);
    // A real wheel gesture over the noneditable page margin must leave all text unchanged.
    await page.mouse.move(4, viewport.height - 30); await page.mouse.wheel(0, 1200);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
    await expect(save).toBeInViewport({ ratio: 1 });
    for (const [name, text] of Object.entries(fields)) await expect(page.getByRole("textbox", { name, exact: true })).toHaveValue(text);
    expect(server.calls.filter(action => action === "save")).toHaveLength(0);
    // Reduced viewport covers the keyboard's available space, without claiming
    // to emulate an actual OS keyboard or its scrolling implementation.
    await page.setViewportSize({ width: viewport.width, height: Math.min(viewport.height, 332) });
    await expect(save).toBeInViewport({ ratio: 1 });
    if (safeArea) expect((await save.boundingBox()).y).toBeGreaterThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("scrolled-reduced.png") });
    await page.getByRole("button", { name: "Show the conversation", exact: true }).click();
    if (viewport.width < 900) {
      await expect(save).toBeHidden();
      await expect(page.getByRole("button", { name: "Back to note", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      await page.mouse.move(4, 290); await page.mouse.wheel(0, 1200);
      await expect(save).toBeInViewport({ ratio: 1 });
      const conversation = page.getByRole("heading", { name: "Conversation", exact: true });
      await expect(conversation).toBeInViewport({ ratio: 1 });
      expect(await conversation.evaluate(el => { const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("conversation-scrolled.png") });
      await page.getByRole("button", { name: "Hide the conversation", exact: true }).click();
    }
    for (const [name, text] of Object.entries(fields)) await expect(page.getByRole("textbox", { name, exact: true })).toHaveValue(text);
    // Keyboard navigation reaches the single Save action, with the last edit
    // flushed through the existing API before dashboard navigation.
    const subjective = page.getByRole("textbox", { name: "Subjective", exact: true });
    const edited = fields.Subjective + " Synthetic reviewed edit.";
    await subjective.fill(edited);
    for (let i = 0; i < 16 && !await save.evaluate(el => el === document.activeElement); i++) await page.keyboard.press("Shift+Tab");
    await expect(save).toBeFocused();
    await expect(save).toBeInViewport({ ratio: 1 });
    expect(await save.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Saved for review", exact: true })).toBeVisible();
    expect(server.calls.filter(action => action === "save")).toHaveLength(1);
    expect(server.current().fields).toEqual({ ...fields, Subjective: edited });
    expect(await page.evaluate(() => globalThis.noteLab.dashboardNoteRefs)).toEqual([server.current().note_ref]);
    expect(await page.evaluate(() => globalThis.__noteLabMediaCalls)).toBe(0);
    server.assertHealthy();
  });
}
