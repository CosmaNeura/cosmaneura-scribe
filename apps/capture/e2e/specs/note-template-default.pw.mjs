/* global document, window, innerWidth */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

for (const width of [320, 1280]) {
  test(`account default remains an explicit, changeable note choice at ${width}px`, async ({ context, page, baseURL }, testInfo) => {
    await context.addInitScript(() => {
      window.__noteMediaCalls = 0;
      for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, method, { value: () => {
        window.__noteMediaCalls++; throw new Error("No media in template selection test");
      } });
    });
    const server = await installNoteServer(context, { origin: baseURL, withDefaultTemplate: true });
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/e2e/fixtures/provider-note.html?dashboard-review");
    await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
    await page.getByRole("button", { name: "Review draft note", exact: true }).click();
    const picker = page.getByRole("combobox", { name: "Template", exact: true });
    await expect(picker).toHaveValue(server.preferred.schema_ref);
    await expect(page.getByText("Your default template is selected. You can choose another before opening the note.", { exact: true })).toBeVisible();
    expect(server.calls.filter(action => ["read", "prepare", "save"].includes(action))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("default-choice.png"), fullPage: true });
    await picker.selectOption(server.template.schema_ref);
    await page.getByRole("button", { name: "Open note", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toHaveValue(server.original.fields.Plan);
    expect(server.calls.filter(action => action === "read")).toHaveLength(1);
    expect(server.calls.filter(action => ["prepare", "save"].includes(action))).toEqual([]);
    expect(server.current()).toEqual(server.original);
    expect(await page.evaluate(() => window.__noteMediaCalls)).toBe(0);
    server.assertHealthy();
  });
}
