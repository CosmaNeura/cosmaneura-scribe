export type WorkflowTimingOutcome = "resolved" | "threw" | "cancelled";
type TimingClock = Pick<Performance, "now" | "clearMeasures" | "measure">;
const actions = new Set([
  "startup", "encounters", "new-encounter", "patient-search", "patient-create", "select-patient",
  "check-creation", "retry-creation", "open", "prepare", "admit", "renew-consent",
  "read", "generate", "save", "resolve", "record", "stop-upload", "resume", "pause",
  "transcript-refresh", "upload-retry",
]);
const outcomes = new Set<unknown>(["resolved", "threw", "cancelled"]);

/** Local User Timing only: bounded fixed names, no identities, text, payloads or export. */
export function beginWorkflowTiming(action: unknown, suppliedClock?: TimingClock | null): (outcome: WorkflowTimingOutcome) => void {
  const noop = (): void => {};
  if (typeof action !== "string" || !actions.has(action)) return noop;
  try {
    const clock = suppliedClock === undefined ? globalThis.performance : suppliedClock;
    if (!clock) return noop;
    const start = clock.now();
    if (!Number.isFinite(start)) return noop;
    let finished = false;
    return (outcome): void => {
      if (finished) return;
      finished = true;
      try {
        const end = clock.now();
        if (!outcomes.has(outcome) || !Number.isFinite(end) || end < start) return;
        const name = `scribe.ui.${action}.${outcome}`;
        // Retain only the latest observation for each fixed action/outcome pair.
        clock.clearMeasures(name);
        clock.measure(name, { start, end });
      } catch { /* Diagnostics never change recording, recovery or save behavior. */ }
    };
  } catch { return noop; }
}
