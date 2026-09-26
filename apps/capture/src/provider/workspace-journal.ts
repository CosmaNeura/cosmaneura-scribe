import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import { isUuid } from "../../../review-ui/src/contracts";
import { type AdmissionIntent, type CoreCaptureScope, requireValue } from "./core-client";
import { canonical, closed, validPendingSave, type PendingNoteSave } from "./core-notes";

interface RecordingProviderProgress {
  readonly admission: AdmissionIntent;
  readonly sessionId: string | null;
  readonly uploaded: boolean;
  readonly pendingSave: PendingNoteSave | null;
}
interface RecoveredProviderProgress {
  /** Read/review recovery never invents an attestation or takes recording custody. */
  readonly admission: null;
  readonly sessionId: string;
  readonly uploaded: true;
  readonly pendingSave: PendingNoteSave | null;
}
export type ProviderProgress = RecordingProviderProgress | RecoveredProviderProgress;
export interface JournalSnapshot { readonly revision: string | null; readonly progress: ProviderProgress | null }
export interface ProviderWorkspaceJournal {
  load(): Promise<JournalSnapshot>;
  /** Atomic compare-and-swap; mismatched concurrent writers must fail closed. */
  save(previous: JournalSnapshot, progress: ProviderProgress): Promise<JournalSnapshot>;
}
export const PROVIDER_JOURNAL_PREFIX = "provider-workspace-v1:";

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
          || canonical(prior.pendingSave) === canonical(progress.pendingSave)));
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
  requireValue(closed(value, "admission,sessionId,uploaded,pendingSave")
    && (value.sessionId === null || isUuid(value.sessionId)) && typeof value.uploaded === "boolean"
    && (!value.uploaded || value.sessionId !== null)
    && (value.pendingSave === null || value.uploaded && validPendingSave(value.pendingSave)));
  if (value.admission === null) { requireValue(value.uploaded === true && isUuid(value.sessionId)); return; }
  requireValue(closed(value.admission, "key,languageMode,attestation") && isUuid(value.admission.key)
    && ["en-US", "en-US+es-US"].includes(String(value.admission.languageMode))
    && closed(value.admission.attestation, "modality,participant_regions,method,all_parties_consented,granted_at"));
  const a = value.admission.attestation;
  requireValue(["in_person", "virtual", "phone"].includes(String(a.modality)) && a.method === "verbal_attestation"
    && a.all_parties_consented === true && typeof a.granted_at === "string" && Number.isFinite(Date.parse(a.granted_at))
    && Array.isArray(a.participant_regions) && a.participant_regions.length > 0 && a.participant_regions.length <= 16
    && new Set(a.participant_regions).size === a.participant_regions.length
    && a.participant_regions.every(v => typeof v === "string" && /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/u.test(v))
    && (value.sessionId === null || isUuid(value.sessionId)) && typeof value.uploaded === "boolean"
    && (!value.uploaded || value.sessionId !== null)
    && (value.pendingSave === null || value.uploaded && validPendingSave(value.pendingSave)));
}
