/** Preserve the original normal consent receipt across the observer's short
 * delivery-cache TTL. This does not renew consent or its timestamps. A current
 * replacement receipt must match, and the current native recorder must still
 * answer for that admitted session. */
export async function readRetainedAdmission(adapter, signal) {
  const admitted = adapter.checkAdmission(adapter.admission);
  const current = await adapter.readAdmission(signal);
  if (current !== null) {
    adapter.checkAdmission(current);
    if (current.sessionId !== admitted.sessionId || current.consentRecordId !== admitted.consentRecordId)
      throw Error('restored_consent_changed');
  }
  const native = await adapter.readRecording(signal);
  return { admission: admitted, native, admissionEvidence: current === null ? 'retained-normal-consent' : 'current-normal-consent' };
}
