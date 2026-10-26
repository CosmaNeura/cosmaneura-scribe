const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isFinite(value?.browserTimeOriginMs) && value.browserTimeOriginMs > 0
  && Number.isFinite(value?.observedAtMonotonicMs) && value.observedAtMonotonicMs >= 0
  ? value.browserTimeOriginMs + value.observedAtMonotonicMs : NaN;
const same = (a, b, keys) => keys.every(key => a?.[key] !== undefined && a[key] === b?.[key]);
const scope = ['runId', 'workspaceId', 'appointmentRef'];
const version = [...scope, 'source', 'action', 'session_id', 'note_ref', 'transcript_ref', 'schema_ref', 'note_sha256', 'source_sha256', 'requestNonce'];
const visitKeys = [...scope, 'connectionId', 'encounterId', 'revision', 'requestId'];
const ready = auth => auth?.source === 'normal-desktop-auth-response' && auth.phase === 'ready'
  && uuid(auth.runId) && uuid(auth.revision) && digest(auth.identitySHA256);

/** A normal open_core reply reauthorizes the existing Desktop encounter and
 * completes navigation. It is neither a new Core save nor a native mount. */
export function validateDesktopSaveCompletion(note, completion) {
  const attempt = completion?.attempt, handoff = completion?.handoff, ui = completion?.ui, current = completion?.currentVisit;
  const auth = completion?.auth, before = attempt?.auth, click = attempt?.click;
  const requestedAt = handoff?.requestBrowserTimeOriginMs + handoff?.requestObservedAtMonotonicMs;
  if (completion?.source !== 'normal-desktop-save-completion' || !uuid(attempt?.nonce)
      || note?.source !== 'normal-core-note-response' || !['read', 'prepare', 'save'].includes(note.action)
      || !same(note, handoff?.note, version) || !same(note, attempt?.note, [...scope, 'session_id', 'transcript_ref', 'schema_ref', 'source_sha256'])
      || !same(note, current, scope) || !same(current, attempt?.visit, visitKeys)
      || !same(current, handoff, [...scope, 'connectionId', 'encounterId', 'revision'])
      || current?.source !== 'normal-native-mount-response' || current.transport !== 'electron-main-ipc'
      || !uuid(current.requestId) || !uuid(current.encounterId) || !uuid(current.revision)
      || handoff?.source !== 'normal-desktop-open-core-response' || handoff.mountRequestId !== current.requestId
      || !uuid(handoff.openCoreRequestId) || handoff.openCoreRequestId === current.requestId
      || handoff.pendingObservedReplies !== 0 || !uuid(handoff.connectionId)
      || !ready(before) || !ready(auth) || !same(before, auth, ['runId', 'revision', 'identitySHA256'])
      || auth.runId !== current.runId || auth.revision !== current.revision || handoff.accountIdentitySHA256 !== auth.identitySHA256
      || attempt.fields?.source !== 'normal-note-editor-fields' || !digest(attempt.fields.fieldsSHA256)
      || note.note_sha256 !== attempt.fields.fieldsSHA256
      || note.note_sha256 !== attempt.note.note_sha256 && (note.action !== 'save'
        || note.note_ref === attempt.note.note_ref || note.requestNonce === attempt.note.requestNonce || time(note) < time(attempt.fields))
      || JSON.stringify(note.field_order) !== JSON.stringify(attempt.fields.fieldOrder)
      || click?.source !== 'normal-desktop-control-response' || click.action !== 'click'
      || !Number.isFinite(click.startedAtEpochMs) || !Number.isFinite(click.completedAtEpochMs)
      || !(time(attempt.fields) <= click.startedAtEpochMs && click.startedAtEpochMs <= requestedAt
        && click.startedAtEpochMs <= click.completedAtEpochMs && click.completedAtEpochMs <= time(ui))
      || ui?.source !== 'normal-saved-review-ui' || ui.heading !== 'Saved for review' || ui.fieldCount !== 0
      || JSON.stringify([...ui.actions ?? []].sort()) !== JSON.stringify(['core', 'encounters'])
      || !['visible', 'hidden'].includes(ui.documentVisibility)
      || !(time(before) <= time(attempt.fields) && time(attempt.fields) - time(before) <= 15000
        && time(note) <= requestedAt && requestedAt <= time(handoff) && time(handoff) <= time(ui)
        && time(auth) <= time(ui) && time(ui) - time(auth) <= 15000
        && time(ui) - time(attempt.fields) <= 120000)) throw Error('desktop_save_completion_unconfirmed');
  return completion;
}
