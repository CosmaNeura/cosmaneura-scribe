import { expect, test } from "@playwright/test";
/* global document, window */

for (const width of [1280, 320]) {
  test(`processing visit opens and starts a separate visit with fresh consent at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      window.mediaRequests = 0;
      for (const name of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, name, {
        value: async () => { window.mediaRequests++; throw new Error("No recording is allowed in this fixture"); },
      });
    });
    await page.goto("/e2e/fixtures/actionable-visits.html");
    await expect(page.getByRole("button", { name: "Open visit", exact: true })).toBeVisible();
    await expect(page.getByText("Preparing your visit…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open visit", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Transcript", exact: true })).toBeVisible();
    await expect(page.locator("[data-transcript-surface]")).toHaveCount(0);
    await page.getByRole("button", { name: "Start a separate visit for this patient", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Start a separate visit", exact: true })).toBeVisible();
    await expect(page.getByText("Start another visit for this patient without changing the earlier recording, transcript or note.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to visit", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.actionableVisitsLab.creates.length)).toBe(0);
    await page.getByRole("button", { name: "Start a new visit for this patient", exact: true }).click();
    await expect(page.locator('[name="consent"]')).toBeVisible();
    await expect(page.locator('[name="consent"]')).not.toBeChecked();
    await expect(page.locator('[data-workspace-action="prepare"]')).toBeDisabled();
    expect(await page.evaluate(() => {
      const lab = window.actionableVisitsLab;
      return { creates: lab.creates.length, patient: lab.creates[0].patient,
        openedRefs: lab.openedRefs, oldRef: lab.oldRef, newRef: lab.newRef,
        oldWrites: lab.oldJournalWrites, newWrites: lab.newJournalWrites,
        recorders: lab.recorderCalls, media: window.mediaRequests, externalRequests: lab.externalRequests };
    })).toEqual({ creates: 1, patient: { kind: "existing", patient_ref: "patient_01j00000000000000000000000" },
      openedRefs: ["appointment_01j00000000000000000000000", "appointment_01j00000000000000000000001"],
      oldRef: "appointment_01j00000000000000000000000", newRef: "appointment_01j00000000000000000000001",
      oldWrites: 0, newWrites: 0, recorders: 0, media: 0, externalRequests: 0 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
}
