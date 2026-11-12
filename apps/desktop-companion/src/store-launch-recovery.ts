/** Fixed Store launch failure copy. No path, entitlement, or credential detail. */
export const STORE_LAUNCH_FAILURE = Object.freeze({
  message: "Scribe could not open",
  detail: "Scribe could not start. Quit and reopen Scribe. If this continues, reinstall from the App Store or contact support.",
  buttons: Object.freeze(["Try again", "Quit"] as const),
});

/** Final non-retryable Store launch failure (same message; Quit only). */
export const STORE_LAUNCH_FAILURE_FINAL = Object.freeze({
  message: STORE_LAUNCH_FAILURE.message,
  detail: STORE_LAUNCH_FAILURE.detail,
  buttons: Object.freeze(["Quit"] as const),
});

/** Maximum Try again attempts after the first failed start in this process. */
export const STORE_LAUNCH_RETRY_LIMIT = 2;

/** Response 0 retries the same process; any other choice quits. */
export function shouldRetryStoreLaunch(response: number): boolean {
  return response === 0;
}
