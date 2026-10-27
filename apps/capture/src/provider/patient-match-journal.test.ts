import { expect, it, vi } from "vitest";
import { openPatientMatchJournal } from "./patient-match-journal";
import type { CreationRecords } from "./encounter-setup";
import type { PendingPatientMatch } from "./patient-match-view";

const scope = { recoveryScope: "00000000-0000-4000-8000-000000000001", appointmentRef: "appointment_01j00000000000000000000000", patientRef: "patient_01j00000000000000000000000" };
const intent: PendingPatientMatch = { key: "00000000-0000-4000-8000-000000000002", expectedVersion: 0, selection: { kind: "confirm_new", dateOfBirth: null } };
function fixture() {
  const rows = new Map<string, { key: string; revision: string; data: string }>();
  let alive = true, refuseClear = false;
  const write = (value: { key: string; data: string }, previous: string | null) => {
    if (refuseClear && JSON.parse(atob(value.data)).pending === null) throw Error("interrupted clear");
    if ((rows.get(value.key)?.revision ?? null) !== previous) throw Error("conflict");
    const revision = String(Number(previous) + 1); rows.set(value.key, { ...value, revision }); return { revision };
  };
  const store: CreationRecords = {
    get: vi.fn(async ({ key }) => { const row = rows.get(key); if (!row) throw Object.assign(Error(), { code: "SECURE_QUEUE_NOT_FOUND" }); return row; }),
    create: vi.fn(async value => write(value, null)),
    compareAndSwap: vi.fn(async value => write(value, value.expectedRevision)),
  };
  const current = () => { if (!alive) throw Error("account changed"); };
  return { store, rows, current, revoke: () => { alive = false; }, refuseClear: () => { refuseClear = true; }, allowClear: () => { refuseClear = false; } };
}

it("retains the original match key across interrupted success cleanup and reopen", async () => {
  const f = fixture(), journal = await openPatientMatchJournal(f.store, scope, f.current);
  expect(journal.local()).toBeNull(); await journal.retain(intent);
  f.refuseClear(); await expect(journal.retain(null)).rejects.toThrow("interrupted clear");
  const reopened = await openPatientMatchJournal(f.store, scope, f.current);
  expect(reopened.local()).toEqual(intent);
  await expect(reopened.retain({ ...intent, key: crypto.randomUUID() })).rejects.toThrow();
  expect(reopened.local()).toEqual(intent);
  // The existing idempotent match API may check this same key again after restart.
  f.allowClear(); await reopened.retain(null); expect(reopened.local()).toBeNull();
  expect([...f.rows.keys()]).toEqual([`provider-patient-match-v1:${scope.recoveryScope}:${scope.appointmentRef}`]);
  expect(JSON.parse(atob([...f.rows.values()][0]!.data))).toEqual({ version: 1, ...scope, pending: null });
});

it.each(["recoveryScope", "appointmentRef", "patientRef"] as const)("rejects foreign %s inside encrypted metadata", async field => {
  const f = fixture(), journal = await openPatientMatchJournal(f.store, scope, f.current); await journal.retain(intent);
  const row = [...f.rows.values()][0]!, value = JSON.parse(atob(row.data)); value[field] = "foreign";
  row.data = btoa(JSON.stringify(value));
  await expect(openPatientMatchJournal(f.store, scope, f.current)).rejects.toThrow("unavailable");
  expect(f.store.compareAndSwap).not.toHaveBeenCalled();
});

it("refuses stale accounts before writes and preserves a concurrent writer", async () => {
  const f = fixture(), first = await openPatientMatchJournal(f.store, scope, f.current), second = await openPatientMatchJournal(f.store, scope, f.current);
  await first.retain(intent); await expect(second.retain(intent)).rejects.toThrow("conflict");
  f.revoke(); await expect(first.retain(null)).rejects.toThrow("account changed"); expect(f.store.compareAndSwap).not.toHaveBeenCalled();
});

it.each([
  { ...intent, expectedVersion: -1 }, { ...intent, selection: { kind: "existing", patientRef: "foreign" } },
  { ...intent, selection: { kind: "confirm_new", dateOfBirth: "2026-02-31" } }, { ...intent, extra: true },
])("refuses malformed pending intents before storage", async value => {
  const f = fixture(), journal = await openPatientMatchJournal(f.store, scope, f.current);
  await expect(journal.retain(value as PendingPatientMatch)).rejects.toThrow(); expect(f.store.create).not.toHaveBeenCalled();
});
