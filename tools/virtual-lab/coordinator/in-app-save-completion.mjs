const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isFinite(value?.browserTimeOriginMs) && value.browserTimeOriginMs > 0
  && Number.isFinite(value?.observedAtMonotonicMs) && value.observedAtMonotonicMs >= 0
  ? value.browserTimeOriginMs + value.observedAtMonotonicMs : NaN;
const same = (a, b, keys) => keys.every(key => a?.[key] !== undefined && a[key] === b?.[key]);
const scope = ['runId', 'workspaceId', 'appointmentRef'];
const version = [...scope, 'source', 'action', 'session_id', 'note_ref', 'transcript_ref', 'schema_ref', 'note_sha256', 'source_sha256', 'requestNonce'];
const visitKeys = [...scope, 'revision', 'requestId'];

/** PR463 confirms Save inside the current mounted visit. A clean editor may
 * already be persisted: preserve its real Core action and request time rather
 * than inventing another save, mount, browser handoff or note identifier. */
export function validateInAppSaveCompletion(note, completion) {
  const { attempt, currentVisit: current, auth, ui, snapshots, platform } = completion ?? {};
  const desktop = platform === 'desktop', before = attempt?.auth, click = attempt?.click;
  const authSource = desktop ? 'normal-desktop-auth-response' : 'normal-native-auth-response';
  const ready = value => value?.source === authSource && value.phase === 'ready'
    && uuid(value.runId) && uuid(value.revision) && digest(value.identitySHA256);
  const fail = () => { throw Error('in_app_save_completion_unconfirmed'); };
  if (completion?.source !== 'normal-in-app-save-completion' || !['desktop', 'ios'].includes(platform)
      || !uuid(attempt?.nonce) || note?.source !== 'normal-core-note-response'
      || !['read', 'prepare', 'save'].includes(note.action) || note.status !== 'draft'
      || !uuid(note.session_id) || !uuid(note.requestNonce) || !digest(note.note_sha256) || !digest(note.source_sha256)
      || !same(note, attempt.note, [...scope, 'session_id', 'transcript_ref', 'schema_ref', 'source_sha256'])
      || !same(note, current, scope) || !same(current, attempt.visit, visitKeys)
      || current.source !== 'normal-native-mount-response' || !uuid(current.requestId) || !uuid(current.revision)
      || desktop && (current.transport !== 'electron-main-ipc' || !uuid(current.connectionId) || !uuid(current.encounterId)
        || !same(current, attempt.visit, ['connectionId', 'encounterId']))
      || !ready(before) || !ready(auth) || !same(before, auth, ['runId', 'revision', 'identitySHA256'])
      || auth.runId !== current.runId || auth.revision !== current.revision
      || attempt.fields?.source !== 'normal-note-editor-fields' || !digest(attempt.fields.fieldsSHA256)
      || note.note_sha256 !== attempt.fields.fieldsSHA256
      || !Array.isArray(note.field_order) || note.field_order.length < 1 || note.field_order.length > 100
      || note.field_order.some(key => typeof key !== 'string' || !key.trim() || key.length > 200)
      || new Set(note.field_order).size !== note.field_order.length
      || JSON.stringify(note.field_order) !== JSON.stringify(attempt.fields.fieldOrder)
      || note.note_sha256 !== attempt.note.note_sha256 && (note.action !== 'save'
        || note.requestNonce === attempt.note.requestNonce || time(note) < time(attempt.fields))
      || click?.source !== (desktop ? 'normal-desktop-control-response' : 'normal-native-control-response')
      || click.action !== 'click' || !Number.isFinite(click.completedAtEpochMs)
      || !(time(before) <= time(attempt.fields) && time(attempt.fields) - time(before) <= 15000
        && time(attempt.fields) <= click.completedAtEpochMs && click.completedAtEpochMs <= time(ui)
        && time(note) <= time(ui) && time(auth) <= time(ui) && time(ui) - time(auth) <= 15000
        && time(ui) - time(attempt.fields) <= 120000)
      || desktop && !(Number.isFinite(click.startedAtEpochMs) && time(attempt.fields) <= click.startedAtEpochMs
        && click.startedAtEpochMs <= click.completedAtEpochMs)
      || ui?.source !== 'normal-saved-review-ui' || ui.heading !== 'Saved for review'
      || ui.fieldCount !== 0 || ui.documentVisibility !== 'visible'
      || JSON.stringify([...ui.actions ?? []].sort()) !== JSON.stringify(['core', 'encounters'])
      || !Array.isArray(snapshots) || snapshots.length !== 2) fail();
  for (const snapshot of snapshots) {
    if (!same(snapshot.currentVisit, current, [...visitKeys, ...(desktop ? ['connectionId', 'encounterId'] : [])])
        || !same(snapshot.currentNote, note, version)
        || JSON.stringify(snapshot.currentNote?.field_order) !== JSON.stringify(note.field_order)
        || snapshot.observerPendingReplies !== 0) fail();
    const recording = snapshot.nativeObservation;
    if (recording && (recording.sessionId !== note.session_id || recording.busy === true || recording.pendingMutation === true
        || (desktop ? recording.phase !== 'stopped' || !['uploading', 'processing', 'complete'].includes(recording.captureState)
          : recording.phase !== 'sealed'))) fail();
    for (const kind of desktop ? ['desktop'] : ['visit', 'admission']) {
      const observer = snapshot.observers?.[kind];
      if (!observer || observer.runId !== current.runId || !digest(observer.observerSHA256)
          || observer.pendingObservedReplies !== 0
          || !same(observer, snapshots[0].observers?.[kind], ['runId', 'observerSHA256'])) fail();
    }
  }
  return completion;
}
