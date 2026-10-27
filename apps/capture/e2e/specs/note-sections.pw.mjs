/* global document, window, innerWidth */
import { expect, test } from "@playwright/test";
import { installNoteServer } from "../support/note-server.mjs";

const fields = {
  "MRN/DOB": "Synthetic identifier retained.", Payer: "Synthetic payer retained.",
  "Patient goals": "The invented patient wants to discuss walking.",
  "S - SUBJECTIVE": "Synthetic history. No symptoms are inferred.", Medications: "No medication list supplied.",
  "O - OBJECTIVE": "No examination was performed.", "A - ASSESSMENT": "No diagnosis supplied.",
  "P - PLAN": "No treatment prescribed.", "Follow-up arrangements": "Discuss at the next synthetic visit.",
  "Custom <heading>": "Custom clinical text must remain discoverable.",
  "Coding, attestation, signature": "No attestation inferred.",
};

for (const viewport of [{ width: 320, height: 640 }, { width: 402, height: 874 }, { width: 1280, height: 800 }]) {
  test(`compact sections preserve every edit and save at ${viewport.width}px`, async ({ context, page, baseURL }, testInfo) => {
    await context.addInitScript(() => {
      window.__noteMediaCalls = 0;
      for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, method, { value: () => {
        window.__noteMediaCalls++; throw new Error("No media in note layout test");
      } });
    });
    const server = await installNoteServer(context, { origin: baseURL, fields });
    await page.setViewportSize(viewport);
    await page.goto("/e2e/fixtures/provider-note.html?dashboard-review");
    await page.locator(`[data-workspace-action="open"][data-appointment="${server.scope.appointmentRef}"]`).click();
    await page.getByRole("button", { name: "Review draft note", exact: true }).click();
    const areas = page.locator("textarea[data-note-field]");
    await expect(areas).toHaveCount(11); await expect(page.locator("textarea[data-note-field]:visible")).toHaveCount(4);
    await expect(page.getByText("Additional note sections (4)", { exact: true })).toBeVisible();
    await expect(page.getByText("Visit details (3)", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Note tools" })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await page.locator(".provider-note-tabs button").all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("compact-note.png"), fullPage: true });
    await page.getByText("Choose expanded sections (11)", { exact: true }).click();
    const choice = page.getByRole("checkbox", { name: "Custom <heading>", exact: true });
    // Real keyboard selection opens both the custom section and its containing group.
    await choice.focus(); await page.keyboard.press("Space");
    const custom = page.getByRole("textbox", { name: "Custom <heading>", exact: true });
    await expect(custom).toBeVisible(); await expect(custom).toHaveValue(fields["Custom <heading>"]);
    const edited = "An explicitly reviewed synthetic custom section.";
    await custom.fill(edited);
    await page.getByRole("button", { name: "Collapse all", exact: true }).click();
    await expect(page.locator("textarea[data-note-field]:visible")).toHaveCount(0);
    await expect(areas).toHaveCount(11);
    for (const [index, key] of Object.keys(fields).entries()) await expect(page.locator(`[name="note-${index}"]`)).toHaveValue(key === "Custom <heading>" ? edited : fields[key]);
    // Transcript navigation and repeated selection never reconstruct the editor.
    await page.getByRole("button", { name: "Transcript", exact: true }).click();
    await expect(page.locator(".provider-note-evidence")).toBeVisible();
    await page.getByRole("button", { name: "Transcript", exact: true }).click();
    await expect(page.locator(".provider-note-evidence")).toBeVisible();
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await expect(page.locator(".provider-note-evidence")).toBeHidden();
    await expect(page.locator("textarea[data-note-field]:visible")).toHaveCount(0);
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    await expect(page.locator("textarea[data-note-field]:visible")).toHaveCount(11);
    await expect(custom).toHaveValue(edited);
    if (viewport.width === 320) await page.addStyleTag({ content: "html { font-size:24px; }" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("expanded-note.png"), fullPage: true });
    await page.getByRole("button", { name: "Save and review", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Saved for review", exact: true })).toBeVisible();
    expect(server.calls.filter(action => action === "save")).toHaveLength(1);
    expect(server.current().fields).toEqual({ ...fields, "Custom <heading>": edited });
    expect(server.current().field_order).toEqual(Object.keys(fields));
    expect(server.original.fields).toEqual(fields);
    expect(await page.evaluate(() => window.__noteMediaCalls)).toBe(0);
    server.assertHealthy();
  });
}
