import { expect, it, vi } from "vitest";
import { assertProgress, NativeProviderWorkspaceJournal, type ProviderProgress } from "./workspace-journal";

const key = "00000000-0000-4000-8000-000000000001";
const base = { admission: null, sessionId: key, uploaded: true, pendingSave: null };
it("continues accepting old recovery journals and bounds private extension data", () => {
  expect(() => assertProgress(base)).not.toThrow();
  const note = { text: "A private fixture", confirmedText: "", version: 0, pending: { text: "A private fixture", expectedVersion: 0, key } };
  expect(() => assertProgress({ ...base, privateNoteState: note })).not.toThrow();
  expect(() => assertProgress({ ...base, privateNoteState: { ...note, text: "x".repeat(2001) } })).toThrow();
  expect(() => assertProgress({ ...base, privateNoteState: { ...note, pending: { ...note.pending, key: "new-key" } } })).toThrow();
  expect(() => assertProgress({ ...base, privateNoteState: note, plaintextFallback: true })).toThrow();
});
it("a submitted preparation intent requires a qualified template and exact reviewed source", () => {
  expect(() => assertProgress({ ...base, notePreparation: { state: "requested", key, schema: null, source: null } })).not.toThrow();
  expect(() => assertProgress({ ...base, notePreparation: { state: "submitted", key, schema: null, source: null } })).toThrow();
  expect(() => assertProgress({ ...base, notePreparation: { state: "requested", key, schema: null, source: { kind: "unreviewed" } } })).toThrow();
});
it("retains exact in-flight private, identity and submitted note requests across compare-and-swap updates", async () => {
  const source = { kind: "reviewed_english" as const, source_version: 1, working_version: 1, working_transcript_id: key };
  const progress: ProviderProgress = { admission: null, sessionId: key, uploaded: true, pendingSave: null,
    privateNoteState: { text: "Newer typing", confirmedText: "", version: 0, pending: { text: "Submitted reminder", expectedVersion: 0, key } },
    pendingPatientMatch: { selection: { kind: "existing", patientRef: "patient_01j" + "0".repeat(23) }, expectedVersion: 0, key },
    notePreparation: { state: "submitted", key, schema: "doctor_note_schema_01j" + "0".repeat(23), source } };
  const plugin = { get: vi.fn(), create: vi.fn().mockResolvedValue({ revision: "1" }), compareAndSwap: vi.fn().mockResolvedValue({ revision: "2" }) };
  const journal = new NativeProviderWorkspaceJournal(plugin, key, { workspaceId: key,
    appointmentRef: "appointment_01j" + "0".repeat(23), bindingRef: "scribe_capture_binding_01j" + "0".repeat(23) });
  const previous = await journal.save({ revision: null, progress: null }, progress);
  const mutations: ProviderProgress[] = [
    { ...progress, privateNoteState: { ...progress.privateNoteState!, pending: { ...progress.privateNoteState!.pending!, text: "Changed retry" } } },
    { ...progress, pendingPatientMatch: { ...progress.pendingPatientMatch!, expectedVersion: 1 } },
    { ...progress, notePreparation: { ...progress.notePreparation!, source: { ...source, working_version: 2 } } },
    { ...progress, notePreparation: { ...progress.notePreparation!, key: "00000000-0000-4000-8000-000000000002" } },
  ];
  for (const changed of mutations) await expect(journal.save(previous, changed)).rejects.toThrow();
  expect(plugin.compareAndSwap).not.toHaveBeenCalled();
  await expect(journal.save(previous, { ...progress, privateNoteState: { ...progress.privateNoteState!, text: "Typing can continue" } })).resolves.toMatchObject({ revision: "2" });
});
