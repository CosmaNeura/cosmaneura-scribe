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
      await page.getByRole("button", { name: "New encounter", exact: true }).click();
      const dob = page.getByLabel("Date of birth (optional)");
      await expect(dob).toBeVisible();
      await expect(dob).not.toHaveAttribute("required");
      await expect(page.getByText("You can record without it. Ask at the start of the visit.")).toBeVisible();
      // Name is still required; an empty form must not silently create a patient.
      await page.getByRole("button", { name: "Create encounter", exact: true }).click();
      expect(await page.evaluate(() => window.dobLab.creates.length)).toBe(0);
      await page.getByLabel("Patient name").fill("Synthetic walk-in");
      if (dateOfBirth) await dob.fill(dateOfBirth);
      await expect(page.getByRole("button", { name: "Create encounter", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("patient-setup.png"), fullPage: true });
      await page.getByRole("button", { name: "Create encounter", exact: true }).click();
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
