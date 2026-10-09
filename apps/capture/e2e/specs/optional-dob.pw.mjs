/* global window */
import { expect, test } from "@playwright/test";

for (const platform of ["desktop", "ios"]) {
  for (const dateOfBirth of [null, "1980-01-02"]) {
    test(`${platform} creates and starts a consented visit with DOB ${dateOfBirth ?? "unknown"}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: platform === "ios" ? 390 : 780, height: 844 });
      await page.addInitScript(() => {
        globalThis.__dobMediaCalls = 0;
        for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, method, { value: () => {
          globalThis.__dobMediaCalls++;
          throw new Error("Real media is forbidden in this virtual DOB test");
        } });
      });
      await page.goto(`/e2e/fixtures/optional-dob.html?platform=${platform}`);
      await page.getByRole("button", { name: "New visit", exact: true }).click();
      // An empty name and an unselected result never create a patient.
      await page.getByRole("button", { name: "Find patient", exact: true }).click();
      expect(await page.evaluate(() => window.dobLab.creates.length)).toBe(0);
      await page.getByLabel("Patient name", { exact: true }).fill("Synthetic walk-in");
      await page.getByRole("button", { name: "Find patient", exact: true }).click();
      await page.getByRole("button", { name: "Create new patient: Synthetic walk-in", exact: true }).click();
      const dob = page.getByLabel("Date of birth (optional)");
      await expect(dob).toBeVisible();
      await expect(dob).not.toHaveAttribute("required");
      await expect(page.getByText("You can record without it. Ask at the start of the visit.")).toBeVisible();
      await expect(page.locator('[name="new-patient-name"]')).toHaveValue("Synthetic walk-in");
      expect(await page.evaluate(() => window.dobLab.creates.length)).toBe(0);
      if (dateOfBirth) await dob.fill(dateOfBirth);
      await expect(page.getByRole("button", { name: "Create patient & continue", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("patient-setup.png"), fullPage: true });
      await page.getByRole("button", { name: "Create patient & continue", exact: true }).click();
      const consent = page.getByRole("button", { name: "Confirm consent & record", exact: true });
      await expect(consent).toBeVisible();
      expect(await page.evaluate(() => window.dobLab.creates.map(body => body.patient))).toEqual([
        { kind: "new", name: "Synthetic walk-in", date_of_birth: dateOfBirth },
      ]);
      expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
      await expect(page.getByLabel("Visit type")).toHaveValue(platform === "ios" ? "in_person" : "virtual");
      await consent.click();
      await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
      expect(await page.evaluate(() => window.dobLab.admissions)).toBe(1);
      expect(await page.evaluate(() => globalThis.__dobMediaCalls)).toBe(0);
    });
  }
}


test("changed search disables stale patient creation and DOB can be added with the same retry request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto("/e2e/fixtures/optional-dob.html?platform=ios&lose-dob");
  await page.getByRole("button", { name: "New visit", exact: true }).click();
  await page.getByLabel("Patient name", { exact: true }).fill("Synthetic first name");
  await page.getByRole("button", { name: "Find patient", exact: true }).click();
  await page.getByLabel("Patient name", { exact: true }).fill("Synthetic walk-in");
  await expect(page.getByRole("button", { name: "Create new patient: Synthetic first name", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Find patient", exact: true }).click();
  await page.getByRole("button", { name: "Create new patient: Synthetic walk-in", exact: true }).click();
  await page.getByRole("button", { name: "Create patient & continue", exact: true }).click();
  await page.getByRole("button", { name: "Add DOB", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add date of birth" })).toBeInViewport();
  await page.getByLabel("Date of birth", { exact: true }).fill("1980-02-03");
  await page.getByRole("button", { name: "Save date of birth", exact: true }).click();
  await expect(page.getByText(/Save is not confirmed/u)).toBeVisible();
  await expect(page.getByLabel("Date of birth", { exact: true })).toHaveAttribute("readonly");
  await page.getByRole("button", { name: "Save date of birth", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText("DOB: 1980-02-03", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add DOB", exact: true })).not.toBeVisible();
  const actual = await page.evaluate(() => window.dobLab);
  expect(actual.dobUpdates).toHaveLength(2);
  expect(actual.dobUpdates[0]).toEqual(actual.dobUpdates[1]);
  expect(actual.creates).toHaveLength(1);
  expect(actual.admissions).toBe(0); expect(actual.starts).toBe(0);
});


test("similar patient names require choosing the displayed chart before creating a visit", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&existing");
  await page.getByRole("button", { name: "New visit", exact: true }).click();
  await page.getByLabel("Patient name", { exact: true }).fill("Synthetic walk-in");
  await page.getByRole("button", { name: "Find patient", exact: true }).click();
  await expect(page.getByRole("button", { name: /Synthetic walk-in DOB:/u })).toHaveCount(2);
  expect(await page.evaluate(() => window.dobLab.creates)).toHaveLength(0);
  await page.getByRole("button", { name: /Synthetic walk-in DOB: 1985-03-04/u }).click();
  await expect(page.getByRole("button", { name: "Confirm consent & record", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.dobLab.creates.map(body => body.patient))).toEqual([
    { kind: "existing", patient_ref: "patient_01j00000000000000000000001" },
  ]);
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
});
