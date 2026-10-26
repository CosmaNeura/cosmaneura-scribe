// Official Node24.22.1/libuv1.52.1 and Homebrew Node24.22.1/libuv1.53.0
// use the verified identical mach_continuous_time implementation on Darwin.
// Swift DispatchTime.uptimeNanoseconds uses scaled mach_absolute_time.
// These are distinct clock domains. No browser timestamp participates here.
const U64 = (1n << 64n) - 1n;
// Analysis accepts only values validated in this process. Reanalyzing retained
// JSON requires projecting its original raw sample again, not trusting a label.
const samples = new WeakSet(), windows = new WeakSet();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail = () => { throw Error('kernel_clock_sample_invalid'); };
export const supportedKernelClockRuntime = (node, uv) => node === '24.22.1' && ['1.52.1', '1.53.0'].includes(uv);
function uint(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64) fail();
  return BigInt(value);
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join() !== keys.slice().sort().join()) fail();
}
const nsFloor = (ticks, n, d) => ticks * n / d;
const nsCeil = (ticks, n, d) => (ticks * n + d - 1n) / d;
const abs = value => value < 0n ? -value : value;
const identityKeys = ['hostname', 'hardwareSHA256', 'bootSessionUUID', 'pid', 'parentPID'];

/** Validate a complete correlated subprocess response, bracketed by the same
 * remote Node process before write and after receipt. This is not a cached
 * product-response bracket or evidence of native session ownership. */
export function projectKernelClockSample({ reply, nodeSentNs, nodeReceivedNs, expectedNonce, expectedRunId,
  expectedIdentity, nodeVersion, uvVersion }) {
  if (!supportedKernelClockRuntime(nodeVersion, uvVersion) || !uuid(expectedNonce) || !uuid(expectedRunId)) fail();
  exactKeys(reply, ['schema', 'source', 'runId', 'nonce', 'sequence', 'identity', 'timebase',
    'continuousBeforeTicks', 'continuousAfterTicks', 'absoluteBeforeTicks', 'absoluteAfterTicks',
    'dispatchRawTicks', 'dispatchUptimeNs', 'audioBeforeSeconds', 'audioAfterSeconds',
    'audioBeforeRoundTripTicks', 'audioAfterRoundTripTicks', 'apiResolutionNs']);
  exactKeys(reply.identity, identityKeys); exactKeys(expectedIdentity, identityKeys);
  if (reply.schema !== 1 || reply.source !== 'owned-kernel-clock' || reply.nonce !== expectedNonce || reply.runId !== expectedRunId
      || !Number.isSafeInteger(reply.sequence) || reply.sequence < 1 || reply.sequence > 64
      || !uuid(reply.identity.bootSessionUUID) || !/^[a-f0-9]{64}$/.test(reply.identity.hardwareSHA256)
      || typeof reply.identity.hostname !== 'string' || !reply.identity.hostname || reply.identity.hostname.length > 255
      || !['pid', 'parentPID'].every(key => Number.isSafeInteger(reply.identity[key]) && reply.identity[key] > 1)
      || identityKeys.some(key => reply.identity[key] !== expectedIdentity[key])) fail();
  exactKeys(reply.timebase, ['numer', 'denom']); exactKeys(reply.apiResolutionNs, ['uptimeRaw', 'monotonicRaw']);
  if (![reply.timebase.numer, reply.timebase.denom].every(value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff)) fail();
  for (const value of Object.values(reply.apiResolutionNs)) if (value !== null && uint(value) === 0n) fail();
  const n = BigInt(reply.timebase.numer), d = BigInt(reply.timebase.denom);
  const sent = uint(nodeSentNs), received = uint(nodeReceivedNs), cb = uint(reply.continuousBeforeTicks), ca = uint(reply.continuousAfterTicks);
  const ab = uint(reply.absoluteBeforeTicks), aa = uint(reply.absoluteAfterTicks), raw = uint(reply.dispatchRawTicks), native = uint(reply.dispatchUptimeNs);
  // Both verified implementations multiply in UInt64 before dividing. Refuse
  // saturation/overflow rather than silently using BigInt to repair the result.
  if ([cb, ca, ab, aa, raw].some(value => value * n > U64) || raw >= (1n << 63n)
      || sent > received || received - sent > 2_000_000_000n || cb > ca || ab > raw || raw > aa
      || ca < aa || native !== nsFloor(raw, n, d)
      || sent > nsFloor(cb, n, d) || nsFloor(ca, n, d) > received) fail();
  for (const [seconds, ticks, roundTrip] of [[reply.audioBeforeSeconds, ab, reply.audioBeforeRoundTripTicks],
    [reply.audioAfterSeconds, aa, reply.audioAfterRoundTripTicks]]) {
    if (!Number.isFinite(seconds) || seconds < 0 || abs(uint(roundTrip) - ticks) > 2n) fail();
    // Check consistency, but never promote a Double round trip into a proven
    // upper error bound for arbitrary future callback timestamps.
    const expected = Number(nsFloor(ticks, n, d)) / 1e9;
    if (Math.abs(seconds - expected) > Math.max(Number.EPSILON * Math.abs(expected) * 4, Number(nsCeil(2n, n, d)) / 1e9)) fail();
  }
  // At the native sample, continuous time is in [cb,ca]. A one-nanosecond
  // outward allowance accounts for independent integer conversion truncation.
  const low = nsFloor(cb, n, d) - native - 1n, high = nsCeil(ca, n, d) - native + 1n;
  const result = Object.freeze({ source: 'owned-kernel-clock-bracket', runId: reply.runId, nonce: reply.nonce, sequence: reply.sequence,
    identity: Object.freeze({ ...reply.identity }), timebase: Object.freeze({ ...reply.timebase }), nodeVersion, uvVersion,
    nodeSentNs, nodeReceivedNs, dispatchUptimeNs: reply.dispatchUptimeNs,
    nodeContinuousMinusNativeUptimeLowerNs: low.toString(), nodeContinuousMinusNativeUptimeUpperNs: high.toString(),
    transportWidthNs: (received - sent).toString(), apiResolutionNs: Object.freeze({ ...reply.apiResolutionNs }),
    audioConversion: 'ROUND_TRIP_CHECKED_NOT_A_GLOBAL_ERROR_BOUND', browserPrecision: 'UNKNOWN',
    nativeSessionAttribution: 'REQUIRES_OWNED_PROCESS_JOURNAL_PROOF', acousticArrival: 'NOT_MEASURED' });
  samples.add(result); return result;
}

/** Bound a measurement window using samples taken on both sides. Continuous
 * minus uptime can grow during sleep; do not intersect that change away. */
export function boundKernelClockWindow(before, after) {
  const keys = ['runId', 'nodeVersion', 'uvVersion'];
  if (!samples.has(before) || !samples.has(after)
      || keys.some(key => before[key] !== after[key])
      || identityKeys.some(key => before.identity?.[key] !== after.identity?.[key])
      || ['numer', 'denom'].some(key => before.timebase?.[key] !== after.timebase?.[key])
      || after.sequence <= before.sequence || after.nonce === before.nonce
      || uint(after.nodeSentNs) < uint(before.nodeReceivedNs)
      || uint(after.dispatchUptimeNs) < uint(before.dispatchUptimeNs)) fail();
  const bl = BigInt(before.nodeContinuousMinusNativeUptimeLowerNs), bu = BigInt(before.nodeContinuousMinusNativeUptimeUpperNs);
  const al = BigInt(after.nodeContinuousMinusNativeUptimeLowerNs), au = BigInt(after.nodeContinuousMinusNativeUptimeUpperNs);
  if (bl > bu || al > au || au < bl) fail();
  const changed = al > bu;
  const result = Object.freeze({ source: 'owned-kernel-clock-window', status: changed ? 'SLEEP_OFFSET_CHANGED' : 'BOUNDED_NO_RESOLVED_SLEEP_CHANGE',
    qualification: changed ? 'NOT_ESTABLISHED' : 'CLOCK_MAPPING_ONLY', runId: before.runId, identity: Object.freeze({ ...before.identity }),
    nativeWindowStartNs: before.dispatchUptimeNs, nativeWindowEndNs: after.dispatchUptimeNs,
    nodeWindowStartNs: before.nodeReceivedNs, nodeWindowEndNs: after.nodeSentNs,
    offsetLowerNs: bl.toString(), offsetUpperNs: au.toString(), uncertaintyWidthNs: (au - bl).toString(),
    browserPrecision: 'UNKNOWN', nativeSessionAttribution: 'REQUIRES_OWNED_PROCESS_JOURNAL_PROOF', acousticArrival: 'NOT_MEASURED' });
  windows.add(result); return result;
}

/** A conservative budget result, not a product acceptance decision. The event
 * must come from an independently attributed current native journal. */
export function boundNativeResponse({ window, nodeActionLowerNs, nodeActionUpperNs, nativeEventNs, budgetNs }) {
  if (!windows.has(window) || window.qualification !== 'CLOCK_MAPPING_ONLY') fail();
  const first = uint(nodeActionLowerNs), last = uint(nodeActionUpperNs), native = uint(nativeEventNs), budget = uint(budgetNs);
  if (first > last || budget === 0n || native < uint(window.nativeWindowStartNs) || native > uint(window.nativeWindowEndNs)
      || first < uint(window.nodeWindowStartNs) || last > uint(window.nodeWindowEndNs)) fail();
  const lower = native + BigInt(window.offsetLowerNs) - last, upper = native + BigInt(window.offsetUpperNs) - first;
  if (upper < 0n || lower > upper) fail();
  return { lowerNs: lower.toString(), upperNs: upper.toString(), budgetNs,
    budgetResult: lower < 0n ? 'INDETERMINATE' : upper <= budget ? 'WITHIN_BOUND' : lower > budget ? 'EXCEEDS_BOUND' : 'INDETERMINATE',
    productAcceptance: 'REQUIRES_NATIVE_EVENT_AND_UI_GATE_PROOF' };
}
