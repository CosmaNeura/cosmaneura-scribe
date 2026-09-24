/** Physical capture is closed, but its server-owned source has not acknowledged
 * retirement. Keep the same recorder and encrypted work available for retry. */
export class CaptureStopAcknowledgementPending extends Error {
  readonly code = "capture_stop_acknowledgement_pending";

  constructor() {
    super("capture_stop_acknowledgement_pending");
    this.name = "CaptureStopAcknowledgementPending";
  }
}
