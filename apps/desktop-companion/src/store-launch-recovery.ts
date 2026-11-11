/** Fixed Store launch failure copy. No path, entitlement, or credential detail. */
export const STORE_LAUNCH_FAILURE = Object.freeze({
  message: "Scribe could not open",
  detail: "Private native services did not finish starting. Check your connection, then try again. If this keeps happening, quit and reopen Scribe.",
  buttons: Object.freeze(["Try again", "Quit"] as const),
});

/** Response 0 retries the same process; any other choice quits. */
export function shouldRetryStoreLaunch(response: number): boolean {
  return response === 0;
}
