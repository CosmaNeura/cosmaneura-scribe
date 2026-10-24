/* global document, window */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getUserMedia", "getDisplayMedia"]) Object.defineProperty(navigator.mediaDevices, method, { value: () => {
      throw new Error("Physical media is forbidden in this synthetic entry fixture");
    } });
  });
});

const openFreshFixtureVisit = async page => {
  await expect(page.locator("#provider")).not.toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: /Synthetic walk-in/u }).click();
  await expect(page.locator(".provider-preparation")).toBeVisible();
};

for (const knownDOB of [false, true]) test(`desktop consent and Start stay together and recording retains the patient at 780px, known DOB=${knownDOB}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 780, height: 760 });
  // Keep the existing dated internal preparation release active in this fixture.
  await page.clock.setFixedTime(new Date("2026-10-24T15:00:00Z"));
  await page.goto(`/e2e/fixtures/optional-dob.html?platform=desktop&recents&layout${knownDOB ? "&known-dob" : ""}`);
  await page.locator('[data-workspace-action="open"]').click();
  const dob = page.getByText("DOB: 1980-01-02", { exact: true });
  if (knownDOB) await expect(dob).toBeInViewport({ ratio: 1 });
  else await expect(dob).toHaveCount(0);
  await page.getByRole("button", { name: "On a video call", exact: false }).click();
  const consent = page.getByRole("checkbox", { name: "The patient said yes", exact: true });
  const start = page.getByRole("button", { name: "Start recording", exact: true });
  await expect(consent).toBeEnabled();
  await expect(consent).not.toBeChecked();
  await expect(start).toBeDisabled();
  await expect(consent).toBeInViewport({ ratio: 1 });
  await expect(start).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("desktop-consent-visible.png") });
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
  // The completed preparation immediately replaces this checkbox's screen.
  await consent.click();
  const controls = page.getByRole("region", { name: "Recording controls", exact: true });
  const identity = controls.getByLabel("Current visit").locator("strong");
  await expect(identity).toHaveText("Synthetic walk-in");
  await expect(identity).toBeVisible();
  await expect(start).toBeEnabled();
  await expect(start).toBeInViewport({ ratio: 1 });
  const changeAudio = controls.getByRole("button", { name: "MacBook Pro Microphone · Change audio", exact: true });
  await expect(changeAudio).toBeInViewport({ ratio: 1 });
  if (knownDOB) await expect(dob).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("desktop-prepared-visible.png") });
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 0]);
  await start.click();
  await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
  await expect(identity).toBeVisible();
  await expect(identity).toBeInViewport({ ratio: 1 });
  if (knownDOB) await expect(dob).toBeInViewport({ ratio: 1 });
  await expect(changeAudio).toBeInViewport({ ratio: 1 });
  await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(controls.getByRole("button", { name: "Finish visit", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("desktop-recording-identity.png") });
});

test("visit loading and retry explain the pending task without implying a recording was lost", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-24T15:00:00Z"));
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents&layout&wait-list");
  await expect(page.getByRole("heading", { name: "Today’s patients", exact: true })).toBeVisible();
  await expect(page.locator("[data-workspace-progress]")).toContainText("Loading today’s patients.");
  await expect(page.locator("#provider")).not.toContainText("Waiting for confirmation");
  await page.evaluate(() => { window.dobLab.failOpen = true; window.dobLab.releaseList(); });
  await page.locator('[data-workspace-action="open"]').click();
  await expect(page.getByRole("heading", { name: "Visit could not open", exact: true })).toBeVisible();
  await expect(page.locator("[data-workspace-notice]")).toContainText("Your saved work is retained. Retry opening the visit.");
  await expect(page.locator("#provider")).not.toContainText("Recording has not started");
  await expect(page.locator("#provider")).not.toContainText("Synthetic private connection detail");
  await page.evaluate(() => { window.dobLab.failOpen = false; });
  await page.getByRole("button", { name: "Retry opening visit", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "The patient said yes", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => [window.dobLab.openedRefs.length, window.dobLab.admissions, window.dobLab.starts])).toEqual([2, 0, 0]);
});

test("narrow preparation keeps the consent action readable without horizontal scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date("2026-10-24T15:00:00Z"));
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents&layout");
  await page.locator('[data-workspace-action="open"]').click();
  const start = page.getByRole("button", { name: "Start recording", exact: true });
  await start.scrollIntoViewIfNeeded();
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("checkbox", { name: "The patient said yes", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
  await page.screenshot({ path: testInfo.outputPath("narrow-consent-visible.png") });
});

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
      await expect(page.getByRole("button", { name: "Create patient & visit", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("patient-setup.png"), fullPage: true });
      await page.getByRole("button", { name: "Create patient & visit", exact: true }).click();
      const consent = page.getByRole("button", { name: "Confirm consent & record", exact: true });
      await expect(consent).toBeVisible();
      await expect(page.locator('[data-workspace-action="confirm-create"]')).toHaveCount(0);
      expect(await page.evaluate(() => window.dobLab.creates.map(body => body.patient))).toEqual([
        { kind: "new", name: "Synthetic walk-in", date_of_birth: dateOfBirth },
      ]);
      expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
      await expect(page.getByLabel("Visit type")).toHaveValue("in_person");
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
  await page.getByRole("button", { name: "Create patient & visit", exact: true }).click();
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
  await expect(page.locator('[data-workspace-action="confirm-create"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.dobLab.creates.map(body => body.patient))).toEqual([
    { kind: "existing", patient_ref: "patient_01j00000000000000000000001" },
  ]);
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
});

test("new-patient expansion retains matching charts and cancellation returns focus without creating", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&existing");
  await page.getByRole("button", { name: "New visit", exact: true }).click();
  await page.getByLabel("Patient name", { exact: true }).fill("Synthetic walk-in");
  await page.getByRole("button", { name: "Find patient", exact: true }).click();
  const choice = page.locator(".provider-create-choice");
  const charts = page.getByRole("list", { name: "Choose patient", exact: true });
  await expect(choice).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-new-patient]")).toHaveCount(0);
  await choice.click();
  await expect(choice).toHaveAttribute("aria-expanded", "true");
  await expect(choice).toHaveText("Hide new patient details");
  await expect(charts.getByRole("button")).toHaveCount(2);
  await expect(charts).toBeVisible();
  await expect(page.getByRole("heading", { name: "New patient: Synthetic walk-in", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Cancel new patient", exact: true }).click();
  await expect(choice).toHaveAttribute("aria-expanded", "false");
  await expect(choice).toBeFocused();
  await expect(page.locator("[data-new-patient]")).toHaveCount(0);
  await expect(charts.getByRole("button")).toHaveCount(2);
  expect(await page.evaluate(() => [window.dobLab.creates.length, window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0, 0]);
  await choice.click();
  // An existing result remains selectable while the new-chart form is open.
  await charts.getByRole("button", { name: /DOB: 1985-03-04/u }).click();
  await expect(page.getByRole("button", { name: "Confirm consent & record", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.dobLab.creates.map(body => body.patient))).toEqual([
    { kind: "existing", patient_ref: "patient_01j00000000000000000000001" },
  ]);
});

test("new-patient disclosure retains DOB across repeated hide and show until explicit submission", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&existing");
  await page.getByRole("button", { name: "New visit", exact: true }).click();
  await page.getByLabel("Patient name", { exact: true }).fill("Synthetic walk-in");
  await page.getByRole("button", { name: "Find patient", exact: true }).click();
  const choice = page.locator(".provider-create-choice");
  await choice.click();
  const dob = page.getByLabel("Date of birth (optional)");
  await dob.fill("1982-06-07");
  for (let i = 0; i < 2; i++) {
    await expect(choice).toHaveText("Hide new patient details");
    await choice.click();
    await expect(choice).toHaveAttribute("aria-expanded", "false");
    await expect(choice).toHaveText("Create new patient: Synthetic walk-in");
    await expect(choice).toBeFocused();
    await expect(dob).toBeHidden();
    await expect(dob).toHaveValue("1982-06-07");
    await expect(page.getByRole("list", { name: "Choose patient", exact: true }).getByRole("button")).toHaveCount(2);
    // A hidden form cannot submit through an accidental/programmatic event.
    await page.locator("[data-new-patient]").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(await page.evaluate(() => [window.dobLab.creates.length, window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0, 0]);
    await choice.click();
    await expect(choice).toHaveAttribute("aria-expanded", "true");
    await expect(dob).toHaveValue("1982-06-07");
    await expect(page.getByRole("heading", { name: "New patient: Synthetic walk-in", exact: true })).toBeFocused();
  }
  await page.getByRole("button", { name: "Create patient & visit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm consent & record", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.dobLab.creates.map(body => body.patient))).toEqual([
    { kind: "new", name: "Synthetic walk-in", date_of_birth: "1982-06-07" },
  ]);
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
});

test("changing a search with an expanded new-patient form blocks stale chart and creation submissions", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&existing");
  await page.getByRole("button", { name: "New visit", exact: true }).click();
  await page.getByLabel("Patient name", { exact: true }).fill("Synthetic walk-in");
  await page.getByRole("button", { name: "Find patient", exact: true }).click();
  await page.getByRole("button", { name: "Create new patient: Synthetic walk-in", exact: true }).click();
  await page.getByLabel("Patient name", { exact: true }).fill("Different synthetic name");
  await expect(page.getByRole("button", { name: "Create patient & visit", exact: true })).toBeDisabled();
  const charts = page.getByRole("list", { name: "Choose patient", exact: true });
  expect(await charts.getByRole("button").evaluateAll(buttons => buttons.every(button => button.disabled))).toBe(true);
  await page.locator("[data-new-patient]").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await charts.getByRole("button").first().evaluate(button => button.dispatchEvent(new Event("click", { bubbles: true })));
  expect(await page.evaluate(() => [window.dobLab.creates.length, window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0, 0]);
  await page.getByRole("button", { name: "Find patient", exact: true }).click();
  await expect(page.locator("[data-new-patient]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create new patient: Different synthetic name", exact: true })).toHaveAttribute("aria-expanded", "false");
});

for (const platform of ["desktop", "ios"]) {
  test(`${platform} keeps one locked setup card visible during fresh admission`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: platform === "ios" ? 390 : 780, height: 844 });
    await page.goto(`/e2e/fixtures/optional-dob.html?platform=${platform}&recents&gate-admission`);
    await openFreshFixtureVisit(page);
    const setup = page.locator(".provider-preparation");
    await expect(setup.getByRole("button", { name: "Confirm consent & record", exact: true })).toBeVisible();
    await page.evaluate(() => { window.dobLab.setupNode = document.querySelector(".provider-preparation"); });
    await setup.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
    await expect(setup.locator("[data-recording-preparation-status]")).toContainText("Recording has not started yet.");
    await expect(page.getByRole("heading", { name: "Record this visit", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preparing your recording…", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.dobLab.setupNode === document.querySelector(".provider-preparation"))).toBe(true);
    expect(await setup.locator('input, select, button:not([data-workspace-action="cancel-recording-action"])').evaluateAll(fields => fields.every(field => field.disabled))).toBe(true);
    await expect(setup.getByRole("button", { name: "Cancel recording start", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 0]);
    if (platform === "desktop") {
      // Even a synthetic event on a disabled field cannot change the captured
      // action or run the detached source-summary listener.
      await setup.locator('[name="desktop-audio"]').evaluate(field => { field.value = "meeting"; field.dispatchEvent(new Event("change", { bubbles: true })); });
      await expect(setup.getByRole("button", { name: "Confirm consent & record", exact: true })).toBeDisabled();
    }
    await page.screenshot({ path: testInfo.outputPath("inline-preparation.png"), fullPage: true });
    await page.evaluate(() => window.dobLab.releaseAdmission());
    await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
    await expect(setup).toHaveCount(0);
  });
}

test("desktop meeting consent stays prepare-only with visible inline window selection", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents");
  await openFreshFixtureVisit(page);
  await page.getByLabel("Visit type").selectOption("virtual");
  await page.getByRole("button", { name: "Confirm consent & prepare recording", exact: true }).click();
  await expect(page.getByText("Choose your meeting window below to enable Start recording.", { exact: true })).toBeVisible();
  const start = page.getByRole("button", { name: "Start recording", exact: true });
  await expect(start).toBeDisabled();
  expect(await page.evaluate(() => window.dobLab.starts)).toBe(0);
  await page.getByLabel("Which call?").selectOption({ label: "Synthetic meeting" });
  await expect(start).toBeEnabled(); await start.click();
  await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
});

test("revocation during inline admission discards the fresh recording action", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents&gate-admission");
  await openFreshFixtureVisit(page);
  await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
  await expect(page.locator("[data-recording-preparation-status]")).toBeVisible();
  await page.evaluate(() => { window.dobLab.signOut(); window.dobLab.releaseAdmission(); });
  await expect(page.locator(".provider-preparation")).toHaveCount(0);
  expect(await page.evaluate(() => window.dobLab.starts)).toBe(0);
});

test("reopening a failed empty desktop start waits for a new manual Start", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents&fail-start");
  await openFreshFixtureVisit(page);
  await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
  const start = page.getByRole("button", { name: "Start recording", exact: true });
  await expect(start).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
  await page.getByRole("button", { name: "Back to encounters", exact: true }).click();
  await page.getByRole("button", { name: /Synthetic walk-in/u }).click();
  await expect(start).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm consent & record", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 1]);
  await start.click(); await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(2);
});

test("a slow failed journal locks the same card and never admits or starts audio", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents&gate-journal&fail-journal");
  await openFreshFixtureVisit(page);
  await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
  const status = page.locator("[data-recording-preparation-status]");
  await expect(status).toContainText("Preparing your recording…");
  await expect(page.getByLabel("Visit type")).toBeDisabled();
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
  await page.evaluate(() => window.dobLab.releaseJournal());
  await expect(status).toContainText("Preparation could not be confirmed");
  await expect(page.getByRole("button", { name: "Confirm consent & record", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([0, 0]);
});

for (const platform of ["desktop", "ios"]) {
  for (const phase of ["journal", "admission", "recorder"]) {
    for (const action of ["leave", "cancel"]) {
      test(`${platform} ${action} during pending ${phase} discards recording but preserves recovery`, async ({ page }) => {
        await page.setViewportSize({ width: platform === "ios" ? 390 : 780, height: 844 });
        await page.goto(`/e2e/fixtures/optional-dob.html?platform=${platform}&recents&gate-${phase}`);
        await openFreshFixtureVisit(page);
        await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
        await expect(page.locator("[data-recording-preparation-status]")).toBeVisible();
        if (phase === "admission") await expect.poll(() => page.evaluate(() => window.dobLab.admissions)).toBe(1);
        if (phase === "recorder") await expect.poll(() => page.evaluate(() => window.dobLab.recorderCalls)).toBe(1);
        await page.getByRole("button", { name: action === "leave" ? "Back to encounters" : "Cancel recording start", exact: true }).click();
        await expect(page.locator("[data-recording-preparation-status]")).toContainText("Recording start canceled.");
        expect(await page.evaluate(() => window.dobLab.starts)).toBe(0);
        await page.evaluate(phase => window.dobLab[`release${phase[0].toUpperCase()}${phase.slice(1)}`](), phase);
        if (action === "leave") {
          await expect(page.getByRole("list", { name: "Authorized encounters", exact: true })).toBeVisible();
          await expect(page.locator("#provider")).not.toHaveAttribute("aria-busy", "true");
          await page.getByRole("button", { name: /Synthetic walk-in/u }).click();
        }
        const manualStart = page.getByRole("button", { name: "Start recording", exact: true });
        await expect(manualStart).toBeEnabled();
        await expect(page.getByRole("button", { name: "Confirm consent & record", exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 0]);
        await manualStart.click(); await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
      });
    }
  }
}

test("compact desktop preparation exposes Cancel and canceled readiness never records", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 420 });
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents&gate-ready");
  await openFreshFixtureVisit(page);
  await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
  const controls = page.getByRole("region", { name: "Recording controls", exact: true });
  const cancel = controls.getByRole("button", { name: "Cancel recording start", exact: true });
  await expect(cancel).toBeInViewport(); await expect(cancel).toBeEnabled();
  await cancel.click(); await page.evaluate(() => window.dobLab.ready());
  const start = page.getByRole("button", { name: "Start recording", exact: true });
  await expect(start).toBeEnabled(); expect(await page.evaluate(() => window.dobLab.starts)).toBe(0);
  await start.click(); await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
});

test("compact desktop exit stays reachable and cancels pending readiness without replaying audio", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 420 });
  await page.goto("/e2e/fixtures/optional-dob.html?platform=desktop&recents&gate-ready");
  await openFreshFixtureVisit(page);
  await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
  const exit = page.getByRole("button", { name: "Back to encounters", exact: true });
  await expect(exit).toBeInViewport();
  await expect(exit).toBeEnabled();
  expect((await exit.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText("Synthetic walk-in", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await exit.click();
  await expect(page.getByRole("list", { name: "Authorized encounters", exact: true })).toBeVisible();
  await page.evaluate(() => window.dobLab.ready());
  expect(await page.evaluate(() => [window.dobLab.admissions, window.dobLab.starts])).toEqual([1, 0]);
  await expect(page.locator("#provider")).not.toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: /Synthetic walk-in/u }).click();
  // This gated fixture prepares each newly acquired recorder, including reopen.
  const manualStart = page.getByRole("button", { name: "Start recording", exact: true });
  await expect(manualStart).toBeDisabled();
  await page.evaluate(() => window.dobLab.ready());
  await expect(manualStart).toBeEnabled();
  expect(await page.evaluate(() => window.dobLab.starts)).toBe(0);
});

test("non-native local provider consent still starts its counted recorder", async ({ page }) => {
  await page.goto("/e2e/fixtures/optional-dob.html?platform=local&recents");
  await openFreshFixtureVisit(page);
  await page.getByRole("button", { name: "Confirm consent & record", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.dobLab.starts)).toBe(1);
  expect(await page.evaluate(() => window.dobLab.admissions)).toBe(1);
});
