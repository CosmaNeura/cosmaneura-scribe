const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fields = ['runId', 'workspaceId', 'appointmentRef', 'sessionId'];
const epoch = value => value?.browserTimeOriginMs + value?.observedAtMonotonicMs;

/** A correlated close is absorbing only while the same passive observer has
 * seen no subsequent capture/auth mutation. A fresh read corroborates that
 * continuity; it never refreshes the original close or invents a native state.
 * This path also requires the journal's same-recorder successful Finish. */
export function closedLifecycleProvesStopped(proof, scenario, observations) {
  const closed = proof?.closedLifecycle, admitted = observations.consent?.admission;
  const visit = proof?.currentVisit, finish = observations.finish?.nativeTerminal;
  const record = observations.record?.nativeObservation;
  const desktop = closed?.source === 'normal-desktop-recorder-close-response';
  if (!closed || !admitted || !finish || !record || proof.nativeObservation !== null
      || admitted.source !== 'normal-native-admission-response' || admitted.runId !== scenario.admissionBinding?.runId
      || visit?.source !== 'normal-native-mount-response'
      || fields.slice(0, 3).some(key => !admitted[key] || visit[key] !== admitted[key])
      || fields.some(key => !admitted[key] || closed[key] !== admitted[key])
      || !uuid(closed.recorderId) || !uuid(closed.closeRequestId) || !uuid(closed.authRevision)
      || closed.authRevision !== admitted.revision || visit.revision !== closed.authRevision || closed.phase !== 'closed'
      || closed.source !== (desktop ? 'normal-desktop-recorder-close-response' : 'normal-native-recorder-close-response')
      || closed.recordingSource !== (desktop ? 'normal-desktop-recording-response' : 'normal-native-recording-response')
      || !(desktop ? ['deactivate', 'workspace_list', 'workspace_open'].includes(closed.closeMethod) : closed.closeMethod === 'close')
      || !Number.isSafeInteger(closed.nativeRevisionBeforeClose) || closed.nativeRevisionBeforeClose < 0
      || !Number.isSafeInteger(closed.captureMutationSequence) || closed.captureMutationSequence < 1
      || closed.currentCaptureMutationSequence !== closed.captureMutationSequence
      || closed.pendingObservedReplies !== 0 || proof.observerPendingReplies !== 0
      || !Number.isFinite(closed.observedAtMonotonicMs) || closed.observedAtMonotonicMs < 0
      || !Number.isFinite(closed.browserTimeOriginMs) || !Number.isFinite(closed.inspectedAtMonotonicMs)
      || closed.inspectedAtMonotonicMs < closed.observedAtMonotonicMs
      || !Number.isFinite(proof.observedAtEpochMs)
      || Math.abs(proof.observedAtEpochMs - closed.browserTimeOriginMs - closed.inspectedAtMonotonicMs) > 5000) return false;
  const descriptors = proof.observers;
  if (!descriptors || Object.keys(descriptors).sort().join() !== 'admission,desktop,visit'
      || (desktop ? descriptors.visit !== null || descriptors.admission !== null || !descriptors.desktop
        : descriptors.desktop !== null || !descriptors.visit || !descriptors.admission)) return false;
  for (const descriptor of Object.values(descriptors).filter(Boolean)) {
    if (descriptor.runId !== admitted.runId || !/^[a-f0-9]{64}$/.test(descriptor.observerSHA256 ?? '')
        || descriptor.pendingObservedReplies !== 0) return false;
  }
  for (const prior of [record, finish]) {
    if (prior.source !== closed.recordingSource || fields.some(key => prior[key] !== closed[key])
        || prior.recorderId !== closed.recorderId || !Number.isSafeInteger(prior.nativeRevision)
        || prior.nativeRevision < 0 || prior.nativeRevision > closed.nativeRevisionBeforeClose
        || !Number.isFinite(epoch(prior)) || epoch(prior) > epoch(closed) + 50) return false;
  }
  return desktop ? finish.phase === 'stopped' && finish.pendingMutation === false
    && ['uploading', 'processing', 'complete'].includes(finish.captureState)
    : finish.phase === 'sealed' && finish.busy === false;
}
