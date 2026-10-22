import type { PendingPatientMatch } from "./patient-match-view";
import type { PrivateNoteLocal } from "./private-note-session";
import { privateText } from "./visit-features";
import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import { isUuid } from "../../../review-ui/src/contracts";
import { type AdmissionIntent, type CoreCaptureScope, requireValue } from "./core-client";
import { canonical, closed, validPendingSave, validSource, type PendingNoteSave, type ReviewedSource } from "./core-notes";
import { reference } from "./core-client";

interface NotePreparationIntent { readonly state: "requested" | "submitted"; readonly key: string;
  readonly schema: string | null; readonly source: ReviewedSource | null }
interface SubmittedNotePreparation extends NotePreparationIntent {
  readonly state: "submitted"; readonly schema: string; readonly source: ReviewedSource;
}
export const MAX_NOTE_PREPARATION_SUCCESSORS = 16;

interface RecordingProviderProgress {
  readonly admission: AdmissionIntent;
  readonly sessionId: string | null;
  readonly uploaded: boolean;
  readonly pendingSave: PendingNoteSave | null;
  /** Latest editor text, encrypted locally; never an instruction to replay a save. */
  readonly queuedNoteEdits?: PendingNoteSave | null;
  readonly privateNoteState?: PrivateNoteLocal;
  readonly pendingPatientMatch?: PendingPatientMatch | null;
  readonly notePreparation?: NotePreparationIntent | null;
  /** Append-only request metadata; the original submitted preparation is retained. */
  readonly notePreparationSuccessors?: readonly SubmittedNotePreparation[];
}
interface RecoveredProviderProgress {
  /** Read/review recovery never invents an attestation or takes recording custody. */
  readonly admission: null;
  readonly sessionId: string;
  readonly uploaded: true;
  readonly pendingSave: PendingNoteSave | null;
  readonly queuedNoteEdits?: PendingNoteSave | null;
  readonly privateNoteState?: PrivateNoteLocal;
  readonly pendingPatientMatch?: PendingPatientMatch | null;
  readonly notePreparation?: NotePreparationIntent | null;
  readonly notePreparationSuccessors?: readonly SubmittedNotePreparation[];
}
export type ProviderProgress = RecordingProviderProgress | RecoveredProviderProgress;
export interface JournalSnapshot { readonly revision: string | null; readonly progress: ProviderProgress | null }
export interface ProviderWorkspaceJournal {
  load(): Promise<JournalSnapshot>;
  /** Atomic compare-and-swap; mismatched concurrent writers must fail closed. */
  save(previous: JournalSnapshot, progress: ProviderProgress): Promise<JournalSnapshot>;
}
export const PROVIDER_JOURNAL_PREFIX = "provider-workspace-v1:";

export function activeNotePreparation(progress: ProviderProgress): NotePreparationIntent | null {
  return progress.notePreparationSuccessors?.at(-1) ?? progress.notePreparation ?? null;
}

/** A correction advances only the working version, never the session's source lineage. */
export function newerNoteSource(previous: ReviewedSource, current: ReviewedSource): boolean {
  return previous.kind === current.kind && previous.source_version === current.source_version
    && previous.working_transcript_id === current.working_transcript_id
    && current.working_version > previous.working_version
    && canonical(previous.capture_continuity ?? null) === canonical(current.capture_continuity ?? null);
}

export function appendNotePreparationSuccessor(progress: ProviderProgress, source: ReviewedSource, key: string): ProviderProgress {
  assertProgress(progress);
  const previous = activeNotePreparation(progress);
  const history = progress.notePreparationSuccessors ?? [];
  requireValue(progress.pendingSave === null && !progress.queuedNoteEdits && previous?.state === "submitted"
    && previous.schema && previous.source && newerNoteSource(previous.source, source)
    && isUuid(key) && key !== previous.key && history.length < MAX_NOTE_PREPARATION_SUCCESSORS);
  const next = { ...progress, notePreparationSuccessors: [...history,
    { state: "submitted" as const, key, schema: previous.schema, source }] };
  assertProgress(next);
  return next;
}

/** Uses the retained device-only encrypted store; never falls back to plaintext. */
export class NativeProviderWorkspaceJournal implements ProviderWorkspaceJournal {
  private readonly key: string;
  constructor(private readonly plugin: Pick<SecureQueuePlugin, "get" | "create" | "compareAndSwap">,
    private readonly recoveryScope: string, private readonly scope: CoreCaptureScope) {
    requireValue(isUuid(recoveryScope) && isUuid(scope.workspaceId));
    this.key = `${PROVIDER_JOURNAL_PREFIX}${recoveryScope}:${scope.workspaceId}`;
  }
  async load(): Promise<JournalSnapshot> {
    let stored;
    try { stored = await this.plugin.get({ key: this.key }); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && error.code === "SECURE_QUEUE_NOT_FOUND") return { revision: null, progress: null };
      // Native errors can contain protected storage details; expose only this boundary failure.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Encounter recovery is unavailable.");
    }
    try {
      requireValue(stored.key === this.key && /^[1-9][0-9]*$/u.test(stored.revision) && stored.data.length <= 2_000_000);
      const bytes = Uint8Array.from(atob(stored.data), c => c.charCodeAt(0));
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      requireValue(closed(value, "version,recoveryScope,scope,progress") && (value.version === 1 || value.version === 2)
        && value.recoveryScope === this.recoveryScope && canonical(value.scope) === canonical(this.scope));
      assertProgress(value.progress);
      requireValue(value.version === (value.progress.admission === null ? 2 : 1));
      return { revision: stored.revision, progress: value.progress };
    } catch { throw new Error("Encounter recovery is unavailable."); }
  }
  async save(previous: JournalSnapshot, progress: ProviderProgress): Promise<JournalSnapshot> {
    assertProgress(progress);
    if (previous.progress) {
      const prior = previous.progress;
      requireValue(canonical(prior.admission) === canonical(progress.admission)
        && (prior.sessionId === null || prior.sessionId === progress.sessionId)
        && (!prior.uploaded || progress.uploaded)
        && (prior.pendingSave === null || progress.pendingSave === null
          || canonical(prior.pendingSave) === canonical(progress.pendingSave))
        && (!prior.pendingPatientMatch || !progress.pendingPatientMatch || canonical(prior.pendingPatientMatch) === canonical(progress.pendingPatientMatch))
        && (!prior.privateNoteState?.pending || !progress.privateNoteState?.pending || canonical(prior.privateNoteState.pending) === canonical(progress.privateNoteState.pending))
        && (prior.notePreparation?.state === "submitted"
          ? canonical(prior.notePreparation) === canonical(progress.notePreparation)
          : !prior.notePreparation || !progress.notePreparation || prior.notePreparation.key === progress.notePreparation.key));
      const before = prior.notePreparationSuccessors ?? [], after = progress.notePreparationSuccessors ?? [];
      requireValue(after.length >= before.length && after.length <= before.length + 1
        && before.every((intent, index) => canonical(intent) === canonical(after[index]))
        && (after.length === before.length || prior.pendingSave === null && !prior.queuedNoteEdits
          && progress.pendingSave === null && !progress.queuedNoteEdits));
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ version: progress.admission === null ? 2 : 1, recoveryScope: this.recoveryScope,
      scope: this.scope, progress }));
    let encoded = "";
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    const data = btoa(encoded);
    const result = previous.revision === null
      ? await this.plugin.create({ key: this.key, data })
      : await this.plugin.compareAndSwap({ key: this.key, data, expectedRevision: previous.revision });
    requireValue(/^[1-9][0-9]*$/u.test(result.revision));
    return { revision: result.revision, progress: structuredClone(progress) };
  }
}

export function assertProgress(value: unknown): asserts value is ProviderProgress {
  const buffered = typeof value === "object" && value !== null && Object.hasOwn(value, "queuedNoteEdits");
  const privateNote = typeof value === "object" && value !== null && Object.hasOwn(value, "privateNoteState");
  const matching = typeof value === "object" && value !== null && Object.hasOwn(value, "pendingPatientMatch");
  const preparing = typeof value === "object" && value !== null && Object.hasOwn(value, "notePreparation");
  const successors = typeof value === "object" && value !== null && Object.hasOwn(value, "notePreparationSuccessors");
  requireValue(closed(value, "admission,sessionId,uploaded,pendingSave" + (buffered ? ",queuedNoteEdits" : "") + (privateNote ? ",privateNoteState" : "") + (matching ? ",pendingPatientMatch" : "") + (preparing ? ",notePreparation" : "") + (successors ? ",notePreparationSuccessors" : ""))
    && (value.sessionId === null || isUuid(value.sessionId)) && typeof value.uploaded === "boolean"
    && (!value.uploaded || value.sessionId !== null)
    && (value.pendingSave === null || value.uploaded && validPendingSave(value.pendingSave)));
  if (buffered) requireValue(value.queuedNoteEdits === null || value.uploaded && validPendingSave(value.queuedNoteEdits));
  if (preparing && value.notePreparation !== null) {
    const intent = value.notePreparation;
    requireValue(closed(intent, "state,key,schema,source") && isUuid(intent.key)
      && (intent.state === "requested" && intent.schema === null && intent.source === null
        || intent.state === "submitted" && value.uploaded && reference(intent.schema, "doctor_note_schema") && validSource(intent.source)));
  }
  if (successors) {
    const history = value.notePreparationSuccessors;
    const first = value.notePreparation;
    requireValue(Array.isArray(history) && history.length <= MAX_NOTE_PREPARATION_SUCCESSORS
      && closed(first, "state,key,schema,source") && first.state === "submitted" && validSource(first.source));
    let previous = first.source;
    const keys = new Set([first.key]);
    for (const intent of history) {
      requireValue(closed(intent, "state,key,schema,source") && intent.state === "submitted"
        && isUuid(intent.key) && !keys.has(intent.key) && intent.schema === first.schema
        && validSource(intent.source) && newerNoteSource(previous, intent.source));
      keys.add(intent.key); previous = intent.source;
    }
  }
  if (matching && value.pendingPatientMatch !== null) {
    const match = value.pendingPatientMatch;
    requireValue(closed(match, "key,expectedVersion,selection") && isUuid(match.key) && Number.isSafeInteger(match.expectedVersion) && Number(match.expectedVersion) >= 0);
    const selection = match.selection;
    requireValue(closed(selection, "kind,patientRef") && selection.kind === "existing" && typeof selection.patientRef === "string" && /^patient_[0-7][0-9a-hjkmnp-tv-z]{25}$/u.test(selection.patientRef)
      || closed(selection, "kind,dateOfBirth") && selection.kind === "confirm_new" && (selection.dateOfBirth === null || typeof selection.dateOfBirth === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(selection.dateOfBirth)));
  }
  if (privateNote) {
    const note = value.privateNoteState;
    requireValue(closed(note, "text,confirmedText,version,pending") && privateText(note.text) && privateText(note.confirmedText)
      && Number.isSafeInteger(note.version) && Number(note.version) >= 0
      && (note.pending === null || closed(note.pending, "text,expectedVersion,key") && privateText(note.pending.text)
        && Number.isSafeInteger(note.pending.expectedVersion) && Number(note.pending.expectedVersion) >= 0 && isUuid(note.pending.key)));
  }
  if (value.admission === null) { requireValue(value.uploaded === true && isUuid(value.sessionId)); return; }
  requireValue(closed(value.admission, "key,languageMode,attestation") && isUuid(value.admission.key)
    && ["en-US", "en-US+es-US"].includes(String(value.admission.languageMode))
    && closed(value.admission.attestation, "modality,participant_regions,method,all_parties_consented,granted_at"));
  const a = value.admission.attestation;
  requireValue(["in_person", "virtual", "phone"].includes(String(a.modality)) && a.method === "verbal_attestation"
    && a.all_parties_consented === true && typeof a.granted_at === "string" && Number.isFinite(Date.parse(a.granted_at))
    && Array.isArray(a.participant_regions) && a.participant_regions.length <= 16
    && new Set(a.participant_regions).size === a.participant_regions.length
    && a.participant_regions.every(v => typeof v === "string" && /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/u.test(v))
    && (value.sessionId === null || isUuid(value.sessionId)) && typeof value.uploaded === "boolean"
    && (!value.uploaded || value.sessionId !== null)
    && (value.pendingSave === null || value.uploaded && validPendingSave(value.pendingSave)));
}
