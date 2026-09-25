export interface IosInputSignal {
  readonly inputBuffers: number;
  readonly convertedBuffers: number;
  readonly inputEverNonzero: boolean;
  readonly convertedEverNonzero: boolean;
  readonly inputLevel: number;
  readonly convertedLevel: number;
  readonly inputAgeMs: number | null;
  readonly convertedAgeMs: number | null;
  readonly zeroInputMs: number;
  readonly inputMuted: boolean;
  readonly route: "built_in" | "bluetooth" | "wired" | "usb" | "other" | "none";
}

const ROUTES: Record<IosInputSignal["route"], string> = {
  built_in: "iPhone microphone", bluetooth: "Bluetooth microphone", wired: "Wired microphone",
  usb: "USB microphone", other: "External microphone", none: "No microphone selected",
};
const KEYS = ["inputBuffers", "convertedBuffers", "inputEverNonzero", "convertedEverNonzero",
  "inputLevel", "convertedLevel", "inputAgeMs", "convertedAgeMs", "zeroInputMs", "route", "inputMuted"].sort().join(",");

/** Reject native error/detail payloads. Only fixed numeric/route metadata enters the view. */
export function parseInputSignal(value: unknown): IosInputSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid input meter");
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(",") !== "signal,version" || envelope.version !== 2) throw new Error("Invalid input meter");
  if (envelope.signal === null) return null;
  if (!envelope.signal || typeof envelope.signal !== "object" || Array.isArray(envelope.signal)) throw new Error("Invalid input meter");
  const data = envelope.signal as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== KEYS) throw new Error("Invalid input meter");
  for (const key of ["inputBuffers", "convertedBuffers", "zeroInputMs", "inputAgeMs", "convertedAgeMs"] as const) {
    if (key.endsWith("AgeMs") && data[key] === null) continue;
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) throw new Error("Invalid input meter");
  }
  for (const key of ["inputLevel", "convertedLevel"] as const) {
    if (typeof data[key] !== "number" || !Number.isFinite(data[key]) || data[key] < 0 || data[key] > 1) throw new Error("Invalid input meter");
  }
  if (typeof data.inputEverNonzero !== "boolean" || typeof data.convertedEverNonzero !== "boolean" || typeof data.inputMuted !== "boolean"
    || typeof data.route !== "string" || !Object.hasOwn(ROUTES, data.route)) throw new Error("Invalid input meter");
  return { ...data } as unknown as IosInputSignal;
}

export function presentInputSignal(signal: IosInputSignal | null, responseAgeMs: number): {
  level: number; route: string; message: string;
} {
  if (!signal || responseAgeMs > 1_500) return { level: 0, route: "Microphone",
    message: "Waiting for microphone signal…" };
  const route = ROUTES[signal.route];
  if (signal.inputMuted) return { level: 0, route,
    message: "Microphone is muted by iOS. Pause and unmute the microphone before resuming." };
  if (signal.inputAgeMs === null || signal.inputAgeMs + responseAgeMs > 1_500
    || signal.convertedAgeMs === null || signal.convertedAgeMs + responseAgeMs > 1_500) {
    return { level: 0, route, message: "Microphone signal is unavailable. If you’re speaking, pause and check the input." };
  }
  // Exact digital zero and conversational quiet are advisory states, never a stop or fatal error.
  if (signal.zeroInputMs >= 3_000) return { level: 0, route,
    message: "No input detected. If you’re speaking, pause and check the microphone." };
  if (signal.inputLevel >= 0.001 && !signal.convertedEverNonzero && signal.inputBuffers >= 10) {
    return { level: 0, route, message: "Audio has not reached the recording yet. If you’re speaking, pause and retry." };
  }
  const rms = signal.convertedLevel;
  const level = rms > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60)) : 0;
  return { level, route, message: level > 0 ? "Microphone activity" : "Quiet input" };
}
