/** Diagnostic clock data only. It never changes capture/consent authority. */
export interface NativeTimingSample {
  readonly version: 1; readonly clock: "dispatch-uptime-ns";
  readonly monotonicNs: string; readonly captureAttempt: number; readonly droppedEvents: number;
}
export interface NativeClockCorrelation {
  readonly nativeClock: "dispatch-uptime-ns"; readonly rendererClock: "performance-now-ms";
  readonly anchorNativeNs: string;
  readonly estimatedRendererAtAnchorLowerMs: number; readonly estimatedRendererAtAnchorUpperMs: number;
  /** Transport widths exclude renderer clock quantization and are not total error bounds. */
  readonly transportRoundTripMs: number; readonly transportBracketWidthMs: number;
  readonly qualification: "NOT_ESTABLISHED"; readonly rendererTimestampResolutionMs: null; readonly uncertaintyMs: null;
  readonly sample: NativeTimingSample;
  readonly sentAtRendererMs: number; readonly receivedAtRendererMs: number; readonly nativeRevision: number;
}
const uint64 = (value: unknown): value is string => typeof value === "string"
  && /^(0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
export function parseNativeTimingSample(value: unknown): NativeTimingSample {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join() !== "captureAttempt,clock,droppedEvents,monotonicNs,version") throw new Error("native_timing_invalid");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || data.clock !== "dispatch-uptime-ns" || !uint64(data.monotonicNs)
      || ![data.captureAttempt, data.droppedEvents].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 2_147_483_647))
    throw new Error("native_timing_invalid");
  return { ...data } as unknown as NativeTimingSample;
}

/** Existing command send/receive samples provide a transport-only estimate.
 * performance.now may be quantized: equal readings do not prove zero error,
 * and observing a minimum clock tick does not establish a maximum error bound.
 * The renderer's resolution and total uncertainty remain NOT_ESTABLISHED/null.
 * No wall clock, assumed granularity, or round-trip midpoint qualifies an event. */
export class NativeClockMapper {
  private last: NativeClockCorrelation | undefined;
  private invalid = false;
  constructor(private readonly sessionId: string, private readonly recorderId: string) {}
  observe(value: { sessionId: string; recorderId: string; revision: number; sample: NativeTimingSample;
    sentAtRendererMs: number; receivedAtRendererMs: number }): NativeClockCorrelation | undefined {
    if (this.invalid || value.sessionId !== this.sessionId || value.recorderId !== this.recorderId
        || !Number.isSafeInteger(value.revision) || value.revision <= (this.last?.nativeRevision ?? 0)) return undefined;
    const { sentAtRendererMs: sent, receivedAtRendererMs: received } = value;
    if (!Number.isFinite(sent) || !Number.isFinite(received) || sent < 0 || received < sent) return undefined;
    const sample = parseNativeTimingSample(value.sample), native = BigInt(sample.monotonicNs);
    const anchor = this.last ? BigInt(this.last.anchorNativeNs) : native;
    if (native < anchor || this.last && (native < BigInt(this.last.sample.monotonicNs)
        || sample.captureAttempt < this.last.sample.captureAttempt
        || sample.captureAttempt === this.last.sample.captureAttempt && sample.droppedEvents < this.last.sample.droppedEvents) || native - anchor > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.invalid = true; return undefined;
    }
    const delta = Number(native - anchor) / 1_000_000;
    const lower = Math.max(this.last?.estimatedRendererAtAnchorLowerMs ?? -Infinity, sent - delta);
    const upper = Math.min(this.last?.estimatedRendererAtAnchorUpperMs ?? Infinity, received - delta);
    if (upper < lower) { this.invalid = true; return undefined; }
    const result: NativeClockCorrelation = { nativeClock: "dispatch-uptime-ns", rendererClock: "performance-now-ms",
      anchorNativeNs: anchor.toString(), estimatedRendererAtAnchorLowerMs: lower, estimatedRendererAtAnchorUpperMs: upper,
      transportRoundTripMs: received - sent, transportBracketWidthMs: upper - lower,
      qualification: "NOT_ESTABLISHED", rendererTimestampResolutionMs: null, uncertaintyMs: null,
      sample, sentAtRendererMs: sent, receivedAtRendererMs: received, nativeRevision: value.revision };
    this.last = structuredClone(result);
    return result;
  }
}

/** Only same-attempt events no later than the native sample may be estimated.
 * Renderer bounds stay explicitly unqualified until a separately justified
 * timestamp-error bound exists. Native offset uses only integer uptime samples. */
export function correlateNativeEvent(event: { monotonicNs: string; captureAttempt: number },
  correlation: NativeClockCorrelation): { qualification: "NOT_ESTABLISHED"; estimatedLowerMs: number;
    estimatedUpperMs: number; uncertaintyMs: null; nativeOffsetFromAnchorMs: number } | null {
  if (!uint64(event.monotonicNs) || event.captureAttempt !== correlation.sample.captureAttempt) return null;
  const native = BigInt(event.monotonicNs), anchor = BigInt(correlation.anchorNativeNs);
  if (native < anchor || native > BigInt(correlation.sample.monotonicNs)
      || native - anchor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const delta = Number(native - anchor) / 1_000_000;
  return { qualification: "NOT_ESTABLISHED", estimatedLowerMs: correlation.estimatedRendererAtAnchorLowerMs + delta,
    estimatedUpperMs: correlation.estimatedRendererAtAnchorUpperMs + delta, uncertaintyMs: null, nativeOffsetFromAnchorMs: delta };
}
