import type { ProviderRecorderSnapshot } from "../provider-binding";

/** Display evidence only. A projected paused state never substitutes for a stop barrier. */
export function settledRecorderVisitStatus(snapshot: ProviderRecorderSnapshot): "paused" | "processing" | undefined {
  if (snapshot.state === "processing" && snapshot.statusCode === "capture_processing") return "processing";
  if (snapshot.state !== "paused" || snapshot.statusCode !== "capture_paused") return undefined;
  if (snapshot.native) return snapshot.native.phase === "paused" && !snapshot.native.busy ? "paused" : undefined;
  if (snapshot.desktop) return ["interrupted", "stopped"].includes(snapshot.desktop.phase)
    && snapshot.desktop.coverage === "complete" ? "paused" : undefined;
  // CaptureFlowController publishes this status only after awaiting source.stop().
  return "paused";
}
