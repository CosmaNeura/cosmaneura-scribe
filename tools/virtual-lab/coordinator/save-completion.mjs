const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isFinite(value?.browserTimeOriginMs) && value.browserTimeOriginMs > 0
  && Number.isFinite(value?.observedAtMonotonicMs) && value.observedAtMonotonicMs >= 0
  ? value.browserTimeOriginMs + value.observedAtMonotonicMs : NaN;
const same = (a, b, keys) => keys.every(key => a?.[key] === b?.[key]);
const scopeKeys = ['runId', 'workspaceId', 'appointmentRef'];
const noteKeys = [...scopeKeys, 'source', 'action', 'session_id', 'note_ref', 'transcript_ref', 'schema_ref', 'note_sha256', 'source_sha256', 'requestNonce'];

/** Passive field digest only. Values never leave the owned renderer. */
export async function snapshotSaveFields(order) {
  const actions = [...document.querySelectorAll('[data-workspace-action="finish-note"]')];
  const fields = [...document.querySelectorAll('textarea[data-note-field]')];
  if (document.visibilityState !== 'visible' || actions.length !== 1 || actions[0].disabled
      || !Array.isArray(order) || !order.length || fields.length !== order.length
      || fields.some((field, i) => field.name !== `note-${i}` || field.disabled || field.readOnly)) return null;
  const values = fields.map(field => field.value);
  if (values.some(value => typeof value !== 'string' || value.length > 100000)) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(order.map((key, i) => [key, values[i]])));
  if (bytes.length > 4194304) return null;
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (fields.some((field, i) => !field.isConnected || field.value !== values[i])
      || document.querySelectorAll('textarea[data-note-field]').length !== fields.length
      || !actions[0].isConnected || actions[0].disabled || document.visibilityState !== 'visible') return null;
  return { source: 'normal-note-editor-fields', fieldsSHA256: hash, fieldOrder: [...order],
    observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin };
}
export const SAVE_FIELDS_SCRIPT = `const done=arguments[arguments.length-1];(${snapshotSaveFields.toString()})(arguments[0]).then(done,()=>done(null));`;
export const SAVE_UI_SCRIPT = `const completion=document.querySelector('.provider-completion');
const buttons=completion?[...completion.querySelectorAll('button')]:[];
const heading=completion?.querySelector('h1')?.textContent;
return {source:'normal-saved-review-ui',heading:heading==='Saved for review'?heading:null,
actions:buttons.filter(button=>!button.disabled).map(button=>button.dataset.workspaceAction),
fieldCount:document.querySelectorAll('textarea[data-note-field]').length,documentVisibility:document.visibilityState,
observedAtMonotonicMs:performance.now(),browserTimeOriginMs:performance.timeOrigin};`;

/** Manual completion is distinct from the Core persistence receipt. Never
 * relabel a prior read/prepare/autosave as a newly issued save request. */
export function validateSaveCompletion(note, completion) {
  const attempt = completion?.attempt, handoff = completion?.handoff, ui = completion?.ui, current = completion?.currentVisit;
  const requestedAt = handoff?.browserTimeOriginMs + handoff?.requestedAtMonotonicMs;
  if (completion?.source !== 'normal-native-save-completion' || !uuid(attempt?.nonce)
      || note?.source !== 'normal-core-note-response' || !['read', 'prepare', 'save'].includes(note.action)
      || attempt.click?.source !== 'normal-native-control-response' || attempt.click.action !== 'click'
      || !Number.isFinite(attempt.click.completedAtEpochMs) || time(attempt.fields) > attempt.click.completedAtEpochMs
      || attempt.click.completedAtEpochMs > time(ui)
      || !digest(attempt.fields?.fieldsSHA256) || attempt.fields.source !== 'normal-note-editor-fields'
      || !same(note, handoff?.note, noteKeys) || !same(note, attempt?.note, [...scopeKeys, 'session_id', 'transcript_ref', 'schema_ref', 'source_sha256'])
      || !same(note, current, scopeKeys) || !same(current, handoff, [...scopeKeys, 'requestId', 'revision'])
      || !same(current, attempt?.visit, [...scopeKeys, 'revision']) || !uuid(current?.requestId)
      || !uuid(current?.revision) || current.requestId === attempt.visit.requestId
      || current.source !== 'normal-native-mount-response' || handoff?.source !== 'normal-native-note-mount-handoff'
      || handoff.pendingObservedReplies !== 0 || note.note_sha256 !== attempt.fields.fieldsSHA256
      || note.note_sha256 !== attempt.note.note_sha256 && (note.action !== 'save'
        || note.note_ref === attempt.note.note_ref || note.requestNonce === attempt.note.requestNonce
        || time(note) < time(attempt.fields))
      || JSON.stringify(note.field_order) !== JSON.stringify(attempt.fields.fieldOrder)
      || ui?.source !== 'normal-saved-review-ui' || ui.heading !== 'Saved for review' || ui.fieldCount !== 0
      || JSON.stringify([...ui.actions ?? []].sort()) !== JSON.stringify(['core', 'encounters'])
      || !['visible', 'hidden'].includes(ui.documentVisibility)
      || !(time(attempt.fields) <= requestedAt && time(note) <= requestedAt
        && requestedAt <= time(handoff) && time(handoff) <= time(ui)
        && time(ui) - time(attempt.fields) <= 120000)
      || time(current) !== time(handoff)) throw Error('native_save_completion_unconfirmed');
  return completion;
}
