/* global window, document */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
});

test("inline meeting selection explains disabled Start and clears the instruction after selection", async ({ page }) => {
  await page.goto("/e2e/fixtures/desktop-controls.html?inline-meeting");
  const start = page.getByRole("button", { name: "Start recording", exact: true });
  const progress = page.getByRole("region", { name: "Recording progress", exact: true });
  const required = page.locator(".meeting-window-required");
  await expect(start).toBeDisabled();
  await expect(progress).toContainText("Choose your call");
  await expect(progress).not.toContainText("Ready to record");
  await expect(required).toContainText("enable Start recording");
  await page.getByTestId("meeting-window").selectOption({ label: "Zoom — Invented visit" });
  await expect(start).toBeEnabled();
  await expect(progress).toContainText("Ready to record");
  await expect(required).toHaveCount(0);
  expect(await page.evaluate(() => window.desktopControlsLab.commands)).toEqual(["meeting_window"]);
  await page.getByTestId("change-meeting-window").click();
  await page.getByRole("button", { name: "Refresh calls", exact: true }).click();
  await expect(start).toBeDisabled();
  await expect(required).toBeVisible();
  await expect(progress).toContainText("Choose your call");
  await page.evaluate(() => window.desktopControlsLab.close());
});

test("optional source changes preserve the visible required window gate and follow confirmed mode", async ({ page }) => {
  await page.goto("/e2e/fixtures/desktop-controls.html?inline-meeting&source-choice");
  const choice = page.locator(".recording-source-choice");
  const source = page.getByTestId("desktop-audio-mode");
  const help = page.locator(".recording-source-help");
  const windowSelect = page.getByTestId("meeting-window");
  const start = page.getByRole("button", { name: "Start recording", exact: true });
  await expect(choice).not.toHaveAttribute("open");
  await expect(source).toBeHidden();
  await expect(windowSelect).toBeVisible();
  await expect(start).toBeDisabled();
  await choice.locator("summary").click();
  await expect(source).toHaveValue("meeting");
  await source.selectOption("microphone");
  await expect(choice.locator("summary")).toContainText("Microphone only");
  await expect(windowSelect).toHaveCount(0);
  await expect(start).toBeEnabled();
  await help.locator("summary").click();
  await expect(help).toContainText("Keep both voices audible");
  await expect(help).not.toContainText("Choose your Zoom window");
  await expect(help).toContainText("Encrypted audio uploads while you record.");
  expect(await page.evaluate(() => window.desktopControlsLab.commands)).toEqual(["source_microphone"]);
  // The existing busy source transition removes the selector until its reply.
  await expect(choice).not.toHaveAttribute("open");
  await choice.locator("summary").click();
  await source.selectOption("meeting");
  await expect(help).toContainText("selected application’s audio");
  await expect(windowSelect).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(choice).not.toHaveAttribute("open");
  await expect(source).toBeHidden();
  await expect(windowSelect).toBeVisible();
  await windowSelect.selectOption({ label: "Zoom — Invented visit" });
  await expect(start).toBeEnabled();
  expect(await page.evaluate(() => window.desktopControlsLab.commands)).toEqual([
    "source_microphone", "source_meeting", "meeting_window",
  ]);
  await page.evaluate(() => window.desktopControlsLab.close());
});

test("interruption confirmation hides Resume until settled and keeps lost-reply recovery visible", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 332 });
  await page.goto("/e2e/fixtures/desktop-controls.html");
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await page.evaluate(() => window.desktopControlsLab.choose());
  const resume = page.getByRole("button", { name: "Resume recording", exact: true });
  await page.evaluate(() => window.desktopControlsLab.confirming());
  await expect(page.getByRole("status")).toHaveText("Confirming recording stopped…");
  await expect(resume).toHaveCount(0);
  await page.evaluate(() => window.desktopControlsLab.confirmationLost());
  await expect(page.getByRole("status")).toHaveText("Recording has stopped. Retry confirmation before uploading.");
  await expect(resume).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry confirmation and upload", exact: true })).toBeInViewport();
  await page.evaluate(() => window.desktopControlsLab.settledPause());
  await expect(resume).toBeEnabled();
  await expect(resume).toBeInViewport();
  await page.evaluate(() => window.desktopControlsLab.close());
});

for (const width of [1280, 640, 480]) {
  test(`desktop controls stay together through choose, record, pause and failed stop at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      for (const method of ["getUserMedia", "getDisplayMedia"]) {
        Object.defineProperty(navigator.mediaDevices, method, { value: () => {
          throw new Error("Real media forbidden");
        } });
      }
    });
    await page.goto("/e2e/fixtures/desktop-controls.html");
    const controls = page.getByRole("region", { name: "Recording controls", exact: true });
    const start = page.getByRole("button", { name: "Start recording", exact: true });
    await expect(start).toBeVisible();
    await expect(page.getByRole("button", { name: "Finish visit", exact: true })).toBeHidden();
    await start.click();
    await expect(controls).toContainText("Recording has not started.");
    await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toBeEnabled();
    await expect(start).toBeHidden();
    await page.getByRole("button", { name: "Show window chooser", exact: true }).click();
    await expect(controls).toContainText("Recording has not started.");
    await expect(controls.getByLabel("Current visit")).toContainText("Avery Example");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("chooser-pending.png") });
    await page.evaluate(() => window.desktopControlsLab.choose());
    if (width === 480) await page.setViewportSize({ width, height: 332 });
    await expect(controls.locator(".recording-duration")).toContainText("1:23");
    const pause = controls.getByRole("button", { name: "Pause", exact: true });
    const stop = controls.getByRole("button", { name: "Finish visit", exact: true });
    await expect(pause).toBeEnabled();
    await expect(controls.getByRole("meter", { name: "Microphone", exact: true })).toHaveAttribute("value", "70");
    await expect(controls.getByRole("meter", { name: "Application audio", exact: true })).toHaveAttribute("value", "80");
    await expect(pause).toBeInViewport();
    await expect(stop).toBeInViewport();
    await expect(controls.getByRole("region", { name: "Recording progress" })).toHaveCount(1);
    await expect(start).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("recording.png") });
    await pause.click();
    await expect(controls.getByRole("status")).toContainText(width === 480
      ? "No audio is being recorded." : "Recording is paused.");
    await expect(pause).toHaveCount(0);
    const resume = controls.getByRole("button", { name: "Resume recording", exact: true });
    await expect(resume).toBeEnabled();
    await expect(resume).toBeInViewport();
    await expect(stop).toBeEnabled();
    await expect(stop).toBeInViewport();
    await expect(page.getByRole("button", { name: "Sign out", exact: true, includeHidden: true })).toBeDisabled();
    if (width === 480) {
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(332);
      await expect(controls.locator(".recording-source-help")).toBeInViewport();
      const exit = page.getByRole("button", { name: "Your encounters", exact: true });
      await expect(exit).toBeInViewport();
      expect((await exit.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await expect(page.getByText("Avery Example", { exact: true }).filter({ visible: true })).toHaveCount(1);
    }
    await page.screenshot({ path: testInfo.outputPath("paused.png") });
    if (width === 1280) {
      await resume.click();
      await expect(pause).toBeEnabled();
    }
    await page.evaluate(() => window.desktopControlsLab.incomplete());
    await expect(page.getByText("Recording coverage is incomplete.", { exact: false })).toBeVisible();
    await stop.click();

    await expect(controls).toContainText("Recording may still be active.");
    await expect(controls.getByRole("button", { name: "Retry finish recording", exact: true })).toBeEnabled();
    await expect(resume).toHaveCount(0);
    await expect(start).toBeHidden();
    await expect(page.getByRole("button", { name: "Sign out", exact: true, includeHidden: true })).toBeDisabled();
    await expect(controls.getByRole("button", { name: "Retry finish recording", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => window.desktopControlsLab.commands))
      .toEqual(width === 1280 ? ["start", "show_chooser", "pause", "resume", "stop"] : ["start", "show_chooser", "pause", "stop"]);
    await page.evaluate(() => window.desktopControlsLab.close());
  });
}

test("desktop meters expire stale IPC and never invent activity for silence or a missing source", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 332 });
  await page.goto("/e2e/fixtures/desktop-controls.html");
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await page.evaluate(() => window.desktopControlsLab.choose());
  const mic = page.getByRole("meter", { name: "Microphone", exact: true });
  const meeting = page.getByRole("meter", { name: "Application audio", exact: true });
  await expect(mic).toHaveAttribute("value", "70");
  await expect(mic).toHaveAttribute("value", "0", { timeout: 2500 });
  await expect(meeting).toHaveAttribute("value", "0");
  await expect(page.getByText("Checking input", { exact: true })).toHaveCount(2);
  await page.evaluate(() => window.desktopControlsLab.quiet());
  await expect(page.getByText("No sound detected", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Checking input", { exact: true })).toHaveCount(1);
  await expect(mic).toHaveAttribute("value", "0");
  await expect(page.getByRole("button", { name: "Finish visit", exact: true })).toBeInViewport();
  await page.evaluate(() => window.desktopControlsLab.close());
});

test("a selected call stays compact and Change retains every manual window without starting audio", async ({ page }) => {
  await page.goto("/e2e/fixtures/desktop-controls.html?inline-meeting");
  await page.evaluate(() => {
    const windows = Array.from({ length: 31 }, (_, n) => ({ id: `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      title: n === 0 ? "Meet - abc-defg-hij" : `Chrome — Invented document ${n}` }));
    window.desktopControlsLab.publish({}, { meetingWindows: { state: "ready", selectedId: windows[0].id, windows } });
  });
  const start = page.getByTestId("record-button"), picker = page.getByTestId("meeting-window");
  await expect(page.getByTestId("selected-meeting-window")).toHaveText("Meet - abc-defg-hij");
  await expect(picker).toBeHidden(); await expect(start).toBeEnabled();
  await page.getByTestId("change-meeting-window").click();
  await expect(picker).toBeVisible(); await expect(start).toBeDisabled();
  await expect(picker.locator("option")).toHaveCount(32);
  await picker.selectOption({ label: "Chrome — Invented document 30" });
  await expect(picker).toBeHidden(); await expect(start).toBeEnabled();
  expect(await page.evaluate(() => window.desktopControlsLab.commands)).toEqual(["meeting_window"]);
  await expect(page.locator("#meeting-window-help")).toContainText("all audio from this app");
  await page.evaluate(() => window.desktopControlsLab.close());
});

test("changed call requires explicit reselection and pending choice never enables Start", async ({ page }) => {
  await page.goto("/e2e/fixtures/desktop-controls.html?inline-meeting&delayed-selection");
  await page.evaluate(() => window.desktopControlsLab.publish({ statusCode: "capture_call_changed" },
    { meetingWindows: { state: "ready", selectedId: "50000000-0000-4000-8000-000000000005",
      windows: [{ id: "50000000-0000-4000-8000-000000000005", title: "Zoom — Invented visit" }] } }));
  const start = page.getByTestId("record-button");
  await expect(page.getByRole("region", { name: "Recording progress", exact: true })).toContainText("The call changed.");
  await expect(start).toBeDisabled(); await page.getByTestId("change-meeting-window").click();
  await expect(page.getByTestId("meeting-window")).toHaveValue("");
  await expect(page.getByTestId("close-meeting-window-picker")).toHaveCount(0);
  await page.getByTestId("meeting-window").selectOption({ label: "Zoom — Invented visit" });
  await expect(start).toBeDisabled();
  await page.evaluate(() => window.desktopControlsLab.acknowledgeSelection());
  await expect(start).toBeEnabled(); await expect(page.getByTestId("meeting-window")).toBeHidden();
  expect(await page.evaluate(() => window.desktopControlsLab.commands)).toEqual(["meeting_window"]);
  await page.evaluate(() => window.desktopControlsLab.close());
});

test("paused recording says Resume recording and saving recovery retains its stop warning", async ({ page }) => {
  await page.goto("/e2e/fixtures/desktop-controls.html?inline-meeting");
  await page.evaluate(() => window.desktopControlsLab.publish({ state: "paused", statusCode: "capture_paused", recordedChunks: 2, elapsedSeconds: 2 },
    { phase: "interrupted", coverage: "incomplete", meetingWindows: { state: "ready", selectedId: "50000000-0000-4000-8000-000000000005",
      windows: [{ id: "50000000-0000-4000-8000-000000000005", title: "Zoom — Invented visit" }] } }));
  await expect(page.getByTestId("resume-recording")).toHaveText("Resume recording");
  await expect(page.getByTestId("meeting-window")).toBeHidden();
  await page.evaluate(() => window.desktopControlsLab.publish({ statusCode: "capture_recovery_pending" }));
  await expect(page.getByTestId("stop-button")).toHaveText("Retry saving");
  await expect(page.getByTestId("stop-button")).toHaveClass("primary");
  await page.evaluate(() => window.desktopControlsLab.confirmationLost());
  await expect(page.getByTestId("resume-recording")).toHaveCount(0);
  await expect(page.getByTestId("stop-button")).toHaveText("Retry confirmation and upload");
  await page.evaluate(() => window.desktopControlsLab.close());
});

test("a paused replacement call directs the provider to the original call or Finish visit", async ({ page }) => {
  await page.goto("/e2e/fixtures/desktop-controls.html?inline-meeting");
  await page.evaluate(() => window.desktopControlsLab.publish({ state: "paused", statusCode: "capture_call_changed", recordedChunks: 2, elapsedSeconds: 2 },
    { phase: "interrupted", coverage: "incomplete", meetingWindows: { state: "ready", selectedId: "50000000-0000-4000-8000-000000000005",
      windows: [{ id: "50000000-0000-4000-8000-000000000005", title: "Zoom — Invented replacement visit" }] } }));
  const progress = page.getByRole("region", { name: "Recording progress", exact: true });
  await expect(progress).toContainText("Return to this visit’s original call");
  await expect(progress).toContainText("If it has ended, choose Finish visit.");
  await expect(page.getByTestId("resume-recording")).toBeDisabled();
  await page.getByTestId("change-meeting-window").click();
  await expect(page.getByTestId("meeting-window")).toHaveValue("");
  await expect(page.getByTestId("stop-button")).toBeEnabled();
  expect(await page.evaluate(() => window.desktopControlsLab.commands)).toEqual([]);
  await page.evaluate(() => window.desktopControlsLab.close());
});
