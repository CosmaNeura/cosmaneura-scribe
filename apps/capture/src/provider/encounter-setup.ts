import { parseEncounterDisplay } from "./encounter-display";
import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import { isUuid } from "../../../review-ui/src/contracts";
import { record, reference } from "./core-client";
import type { ProviderEncounter } from "./workspace-contracts";
import { createVisitFeatures, type VisitFeatures } from "./visit-features";
import { openPatientMatchJournal, type PatientMatchJournal } from "./patient-match-journal";

export interface ProviderPatient { patientRef: string; name: string; dateOfBirth: string | null }
export interface EncounterDraft {
  creationKey: string;
  patient: { kind: "existing"; patientRef: string } | { kind: "new"; name: string; dateOfBirth: string | null; provisional?: boolean };
  appointmentAt: string;
  title: string;
  /** Local navigation intent only; never sent to Core as capture authority. */
  openAfterCreation?: boolean;
}
export interface EncounterSetupState {
  account: string;
  patients: ProviderPatient[];
  moreResults: boolean;
  pending: EncounterDraft | null;
}
export interface ProviderEncounterSetup extends Partial<VisitFeatures> {
  readonly existingPatientOnly?: true;
  patientMatchJournal?(encounter: ProviderEncounter, signal: AbortSignal): Promise<PatientMatchJournal>;
  state(signal: AbortSignal): Promise<EncounterSetupState>;
  search(query: string, signal: AbortSignal): Promise<Omit<EncounterSetupState, "pending">>;
  submit(draft: EncounterDraft | null, signal: AbortSignal): Promise<ProviderEncounter>;
  hidden?(signal: AbortSignal): Promise<readonly string[]>;
  setHidden?(appointmentRef: string, hidden: boolean, signal: AbortSignal): Promise<void>;
  addDateOfBirth?(encounter: ProviderEncounter, dateOfBirth: string, key: string, signal: AbortSignal): Promise<ProviderEncounter>;
}
export type CreationRecords = Pick<SecureQueuePlugin, "get" | "create" | "compareAndSwap">;
export interface ProviderAccount { email: string; environment: string }
export function parseProviderAccount(value: unknown, environment: "Staging" | "Production" = "Staging"): ProviderAccount {
  if (!record(value) || Object.keys(value).sort().join(",") !== "email,environment"
    || value.environment !== environment) throw fail();
  return { email: text(value.email, 320), environment };
}
export function parseSetupState(value: unknown): EncounterSetupState {
  if (!record(value) || Object.keys(value).sort().join(",") !== "account,moreResults,patients,pending"
    || !Array.isArray(value.patients) || value.patients.length > 100 || typeof value.moreResults !== "boolean") throw fail();
  const patients = value.patients.map(raw => {
    if (!record(raw) || Object.keys(raw).sort().join(",") !== "dateOfBirth,name,patientRef"
      || !reference(raw.patientRef, "patient")) throw fail();
    return { patientRef: raw.patientRef, name: text(raw.name), dateOfBirth: birthDate(raw.dateOfBirth) };
  });
  if (new Set(patients.map(p => p.patientRef)).size !== patients.length) throw fail();
  return { account: text(value.account, 320), patients, moreResults: value.moreResults,
    pending: value.pending === null ? null : parseEncounterDraft(value.pending) };
}
type Snapshot = { revision: string | null; pending: EncounterDraft | null };
const PREFIX = "provider-encounter-creation-v1:";
const fail = (): Error => new Error("Encounter creation could not be confirmed. Your pending request is retained.");
const text = (value: unknown, max = 200): string => {
  if (typeof value !== "string" || !value.length || value.length > max || value.includes("\0")) throw fail();
  return value;
};
const birthDate = (value: unknown): string | null => {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text(value, 10))) throw fail();
  return value as string;
};

export function parseEncounterDraft(value: unknown): EncounterDraft {
  if (!record(value) || Object.keys(value).sort().join(",") !== (Object.hasOwn(value, "openAfterCreation")
    ? "appointmentAt,creationKey,openAfterCreation,patient,title" : "appointmentAt,creationKey,patient,title")
    || Object.hasOwn(value, "openAfterCreation") && typeof value.openAfterCreation !== "boolean"
    || !isUuid(value.creationKey) || !record(value.patient)) throw fail();
  const patient = value.patient;
  if (patient.kind === "existing") {
    if (Object.keys(patient).sort().join(",") !== "kind,patientRef" || !reference(patient.patientRef, "patient")) throw fail();
  } else if (patient.kind === "new") {
    if (Object.keys(patient).sort().join(",") !== (Object.hasOwn(patient, "provisional") ? "dateOfBirth,kind,name,provisional" : "dateOfBirth,kind,name")
      || patient.provisional !== undefined && typeof patient.provisional !== "boolean"
      || text(patient.name).trim() !== patient.name) throw fail();
    birthDate(patient.dateOfBirth);
  } else throw fail();
  const stamp = text(value.appointmentAt, 40);
  if (!Number.isFinite(Date.parse(stamp)) || !/(Z|[+-]\d{2}:\d{2})$/u.test(stamp)) throw fail();
  text(value.title);
  return { creationKey: value.creationKey, patient: patient.kind === "existing"
    ? { kind: "existing", patientRef: patient.patientRef as string }
    : { kind: "new", name: patient.name as string, dateOfBirth: birthDate(patient.dateOfBirth), ...(patient.provisional !== undefined ? { provisional: patient.provisional as boolean } : {}) },
    appointmentAt: stamp, title: value.title as string,
    ...(Object.hasOwn(value, "openAfterCreation") ? { openAfterCreation: value.openAfterCreation as boolean } : {}) };
}

export function parseCreatedEncounter(value: unknown): ProviderEncounter & { workspaceId: string } {
  if (!record(value) || !isUuid(value.workspace_id) || !reference(value.appointment_ref, "appointment")) throw fail();
  const display = parseEncounterDisplay({ appointmentRef: value.appointment_ref,
    title: text(value.patient_name), patientName: text(value.patient_name), detail: `${text(value.title)} · ${text(value.appointment_at, 40)}`,
    ...(value.patient_ref !== undefined ? { patientRef: value.patient_ref } : {}),
    ...(value.date_of_birth !== undefined ? { dateOfBirth: value.date_of_birth } : {}),
    ...(value.identity !== undefined ? { identity: value.identity } : {}),
    ...(value.status !== undefined ? { status: value.status } : {}),
  });
  return { workspaceId: value.workspace_id, ...display };
}

/** Shared mobile/desktop retry owner. Every intent is encrypted durably before
 * its first network submission. An uncertain result never rotates the key. */
export function createEncounterSetup(options: {
  request(body: Record<string, unknown>, key: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  records(recoveryScope: string, signal: AbortSignal): Promise<{ records: CreationRecords; close(): Promise<void> }>;
  created(encounter: ProviderEncounter & { workspaceId: string }): void;
  current(signal?: AbortSignal): void;
  canHide?(appointmentRef: string): boolean;
  existingPatientOnly?(): boolean;
}): ProviderEncounterSetup & { initializeCatalog(value: Record<string, unknown>, signal: AbortSignal): void; dispose(): Promise<void> } {
  let recovery: string | null = null, account: string | null = null;
  let storage: Promise<Awaited<ReturnType<typeof options.records>>> | null = null;
  let busy = false;
  const accept = (value: Record<string, unknown>): void => {
    if (!isUuid(value.recoveryScope) || !record(value.account)) throw fail();
    const email = text(value.account.email, 320);
    if ((recovery !== null && value.recoveryScope !== recovery) || (account !== null && email !== account)) throw fail();
    recovery = value.recoveryScope; account = email;
  };
  const journal = async (signal: AbortSignal): Promise<{ records: CreationRecords }> => {
    options.current(signal);
    if (!recovery) throw fail();
    storage ??= options.records(recovery, signal).catch(error => { storage = null; throw error; });
    const opened = await storage;
    // Keep the Capacitor proxy nested: resolving it directly asks for its
    // synthetic `then` method and leaves the caller waiting indefinitely.
    options.current(signal); return opened;
  };
  const load = async (signal: AbortSignal): Promise<Snapshot> => {
    const { records } = await journal(signal), key = PREFIX + recovery;
    let saved;
    try { saved = await records.get({ key }); }
    catch (error) {
      if (record(error) && error.code === "SECURE_QUEUE_NOT_FOUND") return { revision: null, pending: null };
      throw fail();
    }
    options.current(signal);
    if (saved.key !== key || !/^[1-9][0-9]*$/u.test(saved.revision) || saved.data.length > 8192) throw fail();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(saved.data), ch => ch.charCodeAt(0))));
    if (!record(value) || Object.keys(value).sort().join(",") !== "pending,recoveryScope,version"
      || value.version !== 1 || value.recoveryScope !== recovery) throw fail();
    return { revision: saved.revision, pending: value.pending === null ? null : parseEncounterDraft(value.pending) };
  };
  const save = async (previous: Snapshot, pending: EncounterDraft | null, signal: AbortSignal): Promise<Snapshot> => {
    const { records } = await journal(signal), key = PREFIX + recovery;
    const raw = new TextEncoder().encode(JSON.stringify({ version: 1, recoveryScope: recovery, pending }));
    const data = btoa(Array.from(raw, byte => String.fromCharCode(byte)).join(""));
    const saved = previous.revision === null ? await records.create({ key, data })
      : await records.compareAndSwap({ key, data, expectedRevision: previous.revision });
    options.current(signal);
    if (!/^[1-9][0-9]*$/u.test(saved.revision)) throw fail();
    return { revision: saved.revision, pending };
  };
  const search = async (query: string, signal: AbortSignal): Promise<Omit<EncounterSetupState, "pending">> => {
    options.current(signal);
    if (typeof query !== "string" || query.length > 200) throw fail();
    const value = await options.request({ action: "patients", query, request_nonce: crypto.randomUUID() }, crypto.randomUUID(), signal);
    options.current(signal); accept(value);
    if (!Array.isArray(value.patients) || value.patients.length > 100 || typeof value.more_results !== "boolean") throw fail();
    const patients = value.patients.map(raw => {
      if (!record(raw) || !reference(raw.patient_ref, "patient")) throw fail();
      return { patientRef: raw.patient_ref, name: text(raw.name), dateOfBirth: birthDate(raw.date_of_birth) };
    });
    if (new Set(patients.map(p => p.patientRef)).size !== patients.length) throw fail();
    return { account: account!, patients, moreResults: value.more_results };
  };
  const hiddenSnapshot = async (signal: AbortSignal): Promise<{ revision: string | null; refs: string[] }> => {
    if (!recovery) await search("", signal);
    const { records } = await journal(signal), key = "provider-hidden-visits-v1:" + recovery;
    let saved;
    try { saved = await records.get({ key }); }
    catch (error) { if (record(error) && error.code === "SECURE_QUEUE_NOT_FOUND") return { revision: null, refs: [] }; throw fail(); }
    options.current(signal);
    if (saved.key !== key || !/^[1-9][0-9]*$/u.test(saved.revision) || saved.data.length > 100_000) throw fail();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(saved.data), ch => ch.charCodeAt(0))));
    if (!record(value) || Object.keys(value).sort().join(",") !== "recoveryScope,refs,version" || value.version !== 1 || value.recoveryScope !== recovery
      || !Array.isArray(value.refs) || value.refs.length > 1000 || value.refs.some(ref => !reference(ref, "appointment")) || new Set(value.refs).size !== value.refs.length) throw fail();
    return { revision: saved.revision, refs: value.refs as string[] };
  };
  return {
    // Only the backend's current authenticated catalog reply initializes this
    // owner. Older receivers omit the scope and retain the patient-search path.
    initializeCatalog: (value, signal) => {
      options.current(signal);
      if (!record(value.account)) throw fail();
      const email = text(value.account.email, 320);
      if (account !== null && email !== account) throw fail();
      if ("recoveryScope" in value) accept(value);
      else account = email;
    },
    ...createVisitFeatures(async (body, key, signal) => {
      options.current(signal); const value = await options.request(body, key, signal);
      options.current(signal); accept(value); return value;
    }),
    ...(options.canHide ? {
      hidden: async (signal: AbortSignal) => (await hiddenSnapshot(signal)).refs,
      setHidden: async (appointmentRef: string, hidden: boolean, signal: AbortSignal) => {
        options.current(signal);
        if (busy || !reference(appointmentRef, "appointment") || !options.canHide!(appointmentRef)) throw fail();
        busy = true;
        try {
          const saved = await hiddenSnapshot(signal), refs = new Set(saved.refs);
          if (hidden) refs.add(appointmentRef); else refs.delete(appointmentRef);
          if (refs.size > 1000) throw fail();
          const { records } = await journal(signal), key = "provider-hidden-visits-v1:" + recovery;
          const raw = new TextEncoder().encode(JSON.stringify({ version: 1, recoveryScope: recovery, refs: [...refs] }));
          const data = btoa(Array.from(raw, byte => String.fromCharCode(byte)).join("")); raw.fill(0);
          if (saved.revision === null) await records.create({ key, data });
          else await records.compareAndSwap({ key, data, expectedRevision: saved.revision });
          options.current(signal);
        } finally { busy = false; }
      },
    } : {}),
    search,
    patientMatchJournal: async (encounter, signal) => {
      options.current(signal);
      if (!recovery) await search("", signal);
      if (!recovery || !reference(encounter.appointmentRef, "appointment") || !reference(encounter.patientRef, "patient")) throw fail();
      const { records } = await journal(signal);
      return openPatientMatchJournal(records, { recoveryScope: recovery, appointmentRef: encounter.appointmentRef, patientRef: encounter.patientRef }, () => options.current(signal));
    },
    state: async signal => ({ ...(recovery && account && !options.existingPatientOnly?.() ? { account, patients: [], moreResults: false } : await search("", signal)), pending: (await load(signal)).pending }),
    submit: async (input, signal) => {
      options.current(signal);
      if (busy) throw fail();
      busy = true;
      try {
        let saved = await load(signal);
        const draft = input === null ? saved.pending : parseEncounterDraft(input);
        if (!draft || saved.pending !== null && JSON.stringify(saved.pending) !== JSON.stringify(draft)) throw fail();
        if (options.existingPatientOnly?.() && draft.patient.kind !== "existing") throw fail();
        if (saved.pending === null) saved = await save(saved, draft, signal);
        const patient = draft.patient.kind === "existing"
          ? { kind: "existing", patient_ref: draft.patient.patientRef }
          : { kind: "new", name: draft.patient.name, date_of_birth: draft.patient.dateOfBirth, ...(draft.patient.provisional ? { provisional: true } : {}) };
        const value = await options.request({ action: "create", creation_key: draft.creationKey,
          patient, appointment_at: draft.appointmentAt, title: draft.title, request_nonce: crypto.randomUUID() }, draft.creationKey, signal);
        options.current(signal); accept(value);
        if (value.creation_key !== draft.creationKey) throw fail();
        const encounter = parseCreatedEncounter(value.encounter);
        options.created(encounter);
        await save(saved, null, signal);
        return parseEncounterDisplay(encounter);
      } finally { busy = false; }
    },
    addDateOfBirth: async (encounter, dateOfBirth, key, signal) => {
      options.current(signal);
      if (!reference(encounter.appointmentRef, "appointment") || !reference(encounter.patientRef, "patient")
        || encounter.dateOfBirth != null || !isUuid(key) || birthDate(dateOfBirth) === null) throw fail();
      const value = await options.request({ action: "add_birth_date", appointment_ref: encounter.appointmentRef,
        patient_ref: encounter.patientRef, date_of_birth: dateOfBirth, change_key: key,
        request_nonce: crypto.randomUUID() }, key, signal);
      options.current(signal); accept(value);
      const updated = parseCreatedEncounter(value.encounter);
      if (value.change_key !== key || updated.appointmentRef !== encounter.appointmentRef
        || updated.patientRef !== encounter.patientRef || updated.dateOfBirth !== dateOfBirth) throw fail();
      options.created(updated);
      return parseEncounterDisplay(updated);
    },
    dispose: async () => { const closing = storage; if (closing) await (await closing).close(); storage = null; },
  };
}


/** Expose only the server-negotiated existing-patient visit subset. */
export function existingPatientSetup(setup: ProviderEncounterSetup): ProviderEncounterSetup {
  return { existingPatientOnly: true, state: signal => setup.state(signal),
    search: (query, signal) => setup.search(query, signal),
    submit: (draft, signal) => setup.submit(draft, signal),
    ...(setup.hidden ? { hidden: signal => setup.hidden!(signal) } : {}),
    ...(setup.setHidden ? { setHidden: (ref, hidden, signal) => setup.setHidden!(ref, hidden, signal) } : {}) };
}
