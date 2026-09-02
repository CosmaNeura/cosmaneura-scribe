import { expect } from "@playwright/test";

const selectors = Object.freeze({
  beginSession: "[data-testid=begin-session]",
  consentCheckbox: "[data-testid=consent-checkbox]",
  fixedStatus: ".fixed-status",
  flowStatus: "[data-testid=flow-status]",
  queueStatus: "[data-testid=queue-status]",
  recordButton: "[data-testid=record-button]",
  refreshStatus: "[data-testid=refresh-status]",
  stopButton: "[data-testid=stop-button]",
  syntheticOnly: "[data-testid=synthetic-only]",
  transcriptStatus: "[data-testid=transcript-status]",
  transcriptViewName: "Read-only synthetic transcript",
});

export class CapturePage {
  constructor(page) {
    this.page = page;
    this.beginSession = page.locator(selectors.beginSession);
    this.consentCheckbox = page.locator(selectors.consentCheckbox);
    this.fixedStatus = page.locator(selectors.fixedStatus);
    this.flowStatus = page.locator(selectors.flowStatus);
    this.queueStatus = page.locator(selectors.queueStatus);
    this.recordButton = page.locator(selectors.recordButton);
    this.refreshStatus = page.locator(selectors.refreshStatus);
    this.stopButton = page.locator(selectors.stopButton);
    this.syntheticOnly = page.locator(selectors.syntheticOnly);
    this.transcriptStatus = page.locator(selectors.transcriptStatus);
    this.transcriptView = page.getByLabel(selectors.transcriptViewName, {
      exact: true,
    });
  }

  async open(expectedFlowStatus) {
    await this.page.goto("/");
    await expect(this.syntheticOnly).toHaveText("Synthetic data · Microphone test");
    await expect(this.flowStatus).toHaveText(expectedFlowStatus);
  }

  async acceptConsentAndPrepare() {
    await expect(this.consentCheckbox).toBeEnabled();
    await this.consentCheckbox.check();
    await expect(this.beginSession).toBeEnabled();
    await this.beginSession.click();
    await expect(this.flowStatus).toHaveText("ready", { timeout: 20_000 });
    await expect(this.recordButton).toBeEnabled();
  }

  async startRecording() {
    await this.recordButton.click();
    await expect(this.flowStatus).toHaveText("recording");
  }

  async waitForDurableEncryptedChunk() {
    await expect(this.queueStatus).toHaveText("1 encrypted · 90 reserved", {
      timeout: 25_000,
    });
  }

  async assertPausedRecovery() {
    await expect(this.flowStatus).toHaveText("paused");
    await expect(this.fixedStatus).toHaveText("capture_interruption_closing");
    await expect(this.queueStatus).toHaveText("1 encrypted · 90 reserved");
    await expect(this.stopButton).toBeEnabled();
  }

  async assertRecoveredStopBlocked() {
    await this.stopButton.click();
    await expect(this.flowStatus).toHaveText("paused");
    await expect(this.fixedStatus).toHaveText("capture_source_close_unverified");
    await expect(this.queueStatus).toHaveText("1 encrypted · 90 reserved");
  }

  async stopAtHeldUpload() {
    await this.stopButton.click();
    await expect(this.flowStatus).toHaveText("uploading", { timeout: 15_000 });
    await expect(this.queueStatus).toHaveText(/^\d+ uploading$/u, { timeout: 15_000 });
  }

  async waitForCompletion() {
    await expect(this.flowStatus).toHaveText("processing", { timeout: 20_000 });
    await expect(this.queueStatus).toHaveText("0 pending", { timeout: 20_000 });
    await expect(this.refreshStatus).toBeEnabled();
    await this.refreshStatus.click();
    await expect(this.flowStatus).toHaveText("ready", { timeout: 30_000 });
    await expect(this.transcriptStatus).toHaveText("ready", { timeout: 30_000 });
    await expect(this.transcriptView).toBeVisible();
    await expect(this.transcriptView).toContainText(
      "Synthetic transcript content for preview only.",
    );
    await expect(
      this.transcriptView.locator('input, textarea, [contenteditable="true"]'),
    ).toHaveCount(0);
  }
}
