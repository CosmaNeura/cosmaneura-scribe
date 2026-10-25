/** Serialized with passive native observers. Retains metadata from normal Core
 * responses only; never stores note fields, patient text or binding authority. */
export function projectNoteObservation(request, response, scope) {
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const ref = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).test(value);
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!uuid(scope?.runId) || !uuid(scope.workspaceId) || !ref(scope.appointmentRef, 'appointment')
      || !['read', 'prepare', 'save'].includes(request?.action) || !uuid(request.expected_session_id)
      || request.workspace_id !== scope.workspaceId || !uuid(request.request_nonce)
      || !ref(request.binding_ref, 'scribe_capture_binding') || response?.contract_version !== '1'
      || response.binding_ref !== request.binding_ref || response.workspace_id !== request.workspace_id
      || response.request_nonce !== request.request_nonce || response.action !== request.action) return null;
  const receipt = response.receipt;
  if (receipt?.status !== 'draft' || receipt.session_id !== request.expected_session_id
      || !ref(receipt.note_ref, 'visit_note') || !ref(receipt.transcript_ref, 'ai_visit_transcript')
      || !ref(receipt.schema_ref, 'doctor_note_schema') || !digest(receipt.note_sha256)
      || !digest(receipt.source_sha256) || !Array.isArray(receipt.field_order)
      || receipt.field_order.length < 1 || receipt.field_order.length > 100
      || receipt.field_order.some(field => typeof field !== 'string' || !field.trim() || field.length > 200)
      || new Set(receipt.field_order).size !== receipt.field_order.length) return null;
  return { source: 'normal-core-note-response', runId: scope.runId, workspaceId: scope.workspaceId,
    appointmentRef: scope.appointmentRef, action: request.action, session_id: receipt.session_id,
    note_ref: receipt.note_ref, transcript_ref: receipt.transcript_ref, schema_ref: receipt.schema_ref,
    note_sha256: receipt.note_sha256, source_sha256: receipt.source_sha256,
    field_order: [...receipt.field_order],
    requestNonce: request.request_nonce, status: receipt.status,
    observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin };
}
