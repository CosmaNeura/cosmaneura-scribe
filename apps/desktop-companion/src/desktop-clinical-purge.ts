import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
export interface DesktopClinicalScope { readonly recoveryScope: string; readonly workspaceId: string; }
export interface DesktopClinicalDirectoryScopes { readonly records: DesktopClinicalScope; readonly creation: DesktopClinicalScope; }
export type ClinicalPurgeMarkerState = "prepared" | "sent" | "confirmed";
export interface DesktopClinicalPurgePlan { readonly recoveryScope: string; readonly recordsWorkspaceIds: readonly string[]; readonly creationWorkspaceId: string; readonly state: ClinicalPurgeMarkerState; }
export const CLINICAL_PURGE_PENDING_PREFIX = "clinical-purge-pending-v1.";
export const CLINICAL_WORKSPACE_INDEX_NAME = "clinical-workspace-index-v1.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const unavailable = (): Error => new Error("desktop_clinical_scope_unavailable");
const scopeUuid = (v: unknown): string | null => typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
const scopeDigest = (r: string) => createHash("sha256").update(r.toLowerCase()).digest("hex").slice(0, 32);
type WipeFn = (dir: string, plan: DesktopClinicalPurgePlan) => void;
export function resolveDesktopClinicalDirectoryScopes(i: {
  readonly recoveryScope: unknown; readonly recordsWorkspaceId: unknown; readonly creationWorkspaceId: unknown;
}): DesktopClinicalDirectoryScopes {
  const recoveryScope = scopeUuid(i.recoveryScope), recordsWorkspaceId = scopeUuid(i.recordsWorkspaceId);
  const creationWorkspaceId = scopeUuid(i.creationWorkspaceId);
  if (!recoveryScope || !recordsWorkspaceId || !creationWorkspaceId) throw unavailable();
  return { records: { recoveryScope, workspaceId: recordsWorkspaceId }, creation: { recoveryScope, workspaceId: creationWorkspaceId } };
}

export function rememberDesktopClinicalWorkspace(userDataDirectory: string, recoveryScope: string, workspaceId: string): void {
  const scope = scopeUuid(recoveryScope), workspace = scopeUuid(workspaceId);
  if (!scope || !workspace || !isAbsolute(userDataDirectory)) return;
  const path = join(userDataDirectory, CLINICAL_WORKSPACE_INDEX_NAME);
  let index: Record<string, string[]> = {};
  try { if (existsSync(path)) index = JSON.parse(readFileSync(path, "utf8")) as Record<string, string[]>; } catch { index = {}; }
  const prior = index[scope], rows = new Set((Array.isArray(prior) ? prior : []).filter(id => !!scopeUuid(id)));
  rows.add(workspace); index[scope] = [...rows];
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index), { encoding: "utf8", mode: 0o600 }); renameSync(tmp, path);
}

export function listedDesktopClinicalWorkspaces(userDataDirectory: string, recoveryScope: string): string[] {
  const scope = scopeUuid(recoveryScope);
  if (!scope || !isAbsolute(userDataDirectory)) return [];
  const path = join(userDataDirectory, CLINICAL_WORKSPACE_INDEX_NAME);
  try {
    if (!existsSync(path)) return [];
    const rows = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[scope];
    return Array.isArray(rows) ? rows.map(scopeUuid).filter((id): id is string => !!id) : [];
  } catch { return []; }
}

export function planDesktopClinicalPurge(recoveryScope: string, creationWorkspaceId: string, knownWorkspaceIds: readonly string[] = []): DesktopClinicalPurgePlan {
  const scope = scopeUuid(recoveryScope), creation = scopeUuid(creationWorkspaceId);
  if (!scope || !creation) throw unavailable();
  const recordsWorkspaceIds = new Set<string>([creation, ...knownWorkspaceIds.map(scopeUuid).filter((id): id is string => !!id)]);
  return { recoveryScope: scope, creationWorkspaceId: creation, recordsWorkspaceIds: [...recordsWorkspaceIds], state: "prepared" };
}

export function wipeDesktopClinicalDirectories(userDataDirectory: string, scopes: DesktopClinicalDirectoryScopes): void {
  if (typeof userDataDirectory !== "string" || !isAbsolute(userDataDirectory)) throw unavailable();
  DurableDesktopRecordStore.wipeAccount(join(userDataDirectory, "provider-records-v1"), scopes.records.recoveryScope, scopes.records.workspaceId);
  DurableDesktopRecordStore.wipeAccount(join(userDataDirectory, "provider-creation-v1"), scopes.creation.recoveryScope, scopes.creation.workspaceId);
}

export function wipeDesktopClinicalPurgePlan(userDataDirectory: string, plan: DesktopClinicalPurgePlan): void {
  for (const recordsWorkspaceId of plan.recordsWorkspaceIds) {
    wipeDesktopClinicalDirectories(userDataDirectory, resolveDesktopClinicalDirectoryScopes({
      recoveryScope: plan.recoveryScope, recordsWorkspaceId, creationWorkspaceId: plan.creationWorkspaceId,
    }));
  }
  DurableDesktopRecordStore.wipeDirectory(join(userDataDirectory, "scribe-cancellation-v1"));
}

export function purgePendingPath(userDataDirectory: string, recoveryScope: string): string {
  return join(userDataDirectory, `${CLINICAL_PURGE_PENDING_PREFIX}${scopeDigest(recoveryScope)}.json`);
}
function writeMarker(userDataDirectory: string, plan: DesktopClinicalPurgePlan, reason?: string): void {
  if (!isAbsolute(userDataDirectory)) throw unavailable();
  mkdirSync(userDataDirectory, { recursive: true });
  const path = purgePendingPath(userDataDirectory, plan.recoveryScope), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    state: plan.state, recoveryScope: plan.recoveryScope, creationWorkspaceId: plan.creationWorkspaceId,
    recordsWorkspaceIds: plan.recordsWorkspaceIds, ...(reason ? { reason } : {}),
  }), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export const writeClinicalPurgePending = (d: string, plan: DesktopClinicalPurgePlan, reason?: string): void =>
  writeMarker(d, { ...plan, state: plan.state ?? "prepared" }, reason);
export const writeClinicalPurgeSent = (d: string, plan: DesktopClinicalPurgePlan): void =>
  writeMarker(d, { ...plan, state: "sent" });
export const confirmClinicalPurgePending = (d: string, plan: DesktopClinicalPurgePlan): void =>
  writeMarker(d, { ...plan, state: "confirmed" });

function readOneMarker(path: string): DesktopClinicalPurgePlan | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof raw.recoveryScope !== "string" || typeof raw.creationWorkspaceId !== "string" || !Array.isArray(raw.recordsWorkspaceIds)) return null;
    const state = raw.state === "confirmed" ? "confirmed"
      : raw.state === "sent" ? "sent"
      : raw.state === "prepared" ? "prepared" : null;
    if (!state) return null;
    const recordsWorkspaceIds = raw.recordsWorkspaceIds.map(scopeUuid).filter((id): id is string => !!id);
    if (recordsWorkspaceIds.length !== raw.recordsWorkspaceIds.length) return null;
    const recoveryScope = scopeUuid(raw.recoveryScope), creationWorkspaceId = scopeUuid(raw.creationWorkspaceId);
    if (!recoveryScope || !creationWorkspaceId) return null;
    return { recoveryScope, creationWorkspaceId, recordsWorkspaceIds, state };
  } catch { return null; }
}

export function readClinicalPurgePending(userDataDirectory: string, recoveryScope?: string): DesktopClinicalPurgePlan | null {
  if (recoveryScope) return readOneMarker(purgePendingPath(userDataDirectory, recoveryScope));
  for (const plan of listClinicalPurgePending(userDataDirectory)) return plan;
  return null;
}

export function listClinicalPurgePending(userDataDirectory: string): DesktopClinicalPurgePlan[] {
  if (!isAbsolute(userDataDirectory) || !existsSync(userDataDirectory)) return [];
  try {
    return readdirSync(userDataDirectory).filter(n => n.startsWith(CLINICAL_PURGE_PENDING_PREFIX) && n.endsWith(".json"))
      .map(n => readOneMarker(join(userDataDirectory, n))).filter((p): p is DesktopClinicalPurgePlan => !!p);
  } catch { return []; }
}

export function clearClinicalPurgePending(userDataDirectory: string, recoveryScope: string): void {
  try { const path = purgePendingPath(userDataDirectory, recoveryScope); if (existsSync(path)) unlinkSync(path); } catch { /* keep marker if unlink fails */ }
}

export function abandonPreparedClinicalPurge(userDataDirectory: string, recoveryScope: string): void {
  const plan = readClinicalPurgePending(userDataDirectory, recoveryScope);
  if (plan?.state === "prepared") clearClinicalPurgePending(userDataDirectory, recoveryScope);
}

export function anyClinicalPurgePending(userDataDirectory: string): boolean {
  return listClinicalPurgePending(userDataDirectory).length > 0;
}
export function anyConfirmedClinicalPurgePending(userDataDirectory: string): boolean {
  return listClinicalPurgePending(userDataDirectory).some(p => p.state === "confirmed");
}

export function retryClinicalPurgePending(
  userDataDirectory: string, options?: { readonly wipe?: WipeFn; readonly log?: (reason: string) => void },
): boolean {
  const wipe = options?.wipe ?? wipeDesktopClinicalPurgePlan;
  let any = false;
  for (const plan of listClinicalPurgePending(userDataDirectory)) {
    if (plan.state !== "confirmed") continue;
    any = true;
    try { wipe(userDataDirectory, plan); clearClinicalPurgePending(userDataDirectory, plan.recoveryScope); }
    catch { options?.log?.("clinical_purge_retry_failed"); writeMarker(userDataDirectory, { ...plan, state: "confirmed" }, "clinical_purge_retry_failed"); return false; }
  }
  return any;
}

/** Discard prepared when the account is alive again. Never wipe from signedOut/unavailable (B5). */
export function resolvePreparedClinicalPurge(
  userDataDirectory: string,
  observation: { readonly recoveryScope?: string | null; readonly revoked?: boolean },
): void {
  if (observation.revoked) return;
  for (const plan of listClinicalPurgePending(userDataDirectory)) {
    if (plan.state !== "prepared") continue;
    const same = !observation.recoveryScope
      || scopeUuid(observation.recoveryScope) === plan.recoveryScope;
    if (same) clearClinicalPurgePending(userDataDirectory, plan.recoveryScope);
  }
}

export function createDesktopClinicalPurgeHost(options: {
  readonly userDataDirectory: string; readonly creationWorkspaceId: string;
  readonly recoveryScope?: () => string | null; readonly loadCatalog?: () => Promise<Record<string, unknown>>;
  readonly wipe?: WipeFn; readonly log?: (reason: string) => void;
}): {
  prepareClinicalPurge: () => Promise<() => Promise<void>>; abandonClinicalPurge: () => void;
  markClinicalPurgeSent: () => void; confirmClinicalPurge: () => void;
  retryPendingPurge: () => boolean;
  resolvePreparedPurge: (observation: { recoveryScope?: string | null; revoked?: boolean }) => void;
  hasPendingPurge: () => boolean; currentPlan: () => DesktopClinicalPurgePlan | null;
} {
  const { userDataDirectory, creationWorkspaceId, recoveryScope, loadCatalog, log } = options;
  const wipe = options.wipe ?? wipeDesktopClinicalPurgePlan, ro = { wipe, ...(log ? { log } : {}) };
  let current: DesktopClinicalPurgePlan | null = null;
  return {
    currentPlan: () => current,
    // H6: only confirmed markers block sign_in/connect after retry.
    hasPendingPurge: () => anyConfirmedClinicalPurgePending(userDataDirectory),
    abandonClinicalPurge: () => { const s = current?.recoveryScope ?? recoveryScope?.(); if (s) abandonPreparedClinicalPurge(userDataDirectory, s); current = null; },
    markClinicalPurgeSent: () => {
      if (!current) return;
      writeClinicalPurgeSent(userDataDirectory, current); current = { ...current, state: "sent" };
    },
    confirmClinicalPurge: () => { if (!current) return; confirmClinicalPurgePending(userDataDirectory, current); current = { ...current, state: "confirmed" }; },
    retryPendingPurge: () => retryClinicalPurgePending(userDataDirectory, ro),
    resolvePreparedPurge: o => resolvePreparedClinicalPurge(userDataDirectory, o),
    prepareClinicalPurge: async () => {
      let rs = recoveryScope?.() ?? null;
      const known = new Set<string>();
      if (loadCatalog) {
        try {
          const catalog = await loadCatalog(), fromCatalog = scopeUuid(catalog.recoveryScope);
          if (fromCatalog) rs = fromCatalog;
          if (Array.isArray(catalog.encounters)) {
            for (const row of catalog.encounters) {
              if (!row || typeof row !== "object" || !("workspaceId" in row)) continue;
              const id = scopeUuid((row as { workspaceId: unknown }).workspaceId);
              if (id) known.add(id);
            }
          }
        } catch { /* catalog must not block DELETE when recoveryScope known */ }
      }
      if (!rs) throw unavailable();
      for (const id of listedDesktopClinicalWorkspaces(userDataDirectory, rs)) known.add(id);
      // Never demote an earlier-attempt sent marker (B1 recovery).
      const prior = readClinicalPurgePending(userDataDirectory, rs);
      if (prior?.state === "sent") {
        current = prior;
        return () => {
          try {
            confirmClinicalPurgePending(userDataDirectory, prior);
            wipe(userDataDirectory, { ...prior, state: "confirmed" });
            clearClinicalPurgePending(userDataDirectory, prior.recoveryScope);
            current = null; return Promise.resolve();
          } catch {
            log?.("clinical_purge_wipe_failed");
            writeMarker(userDataDirectory, { ...prior, state: "confirmed" }, "clinical_purge_wipe_failed");
            return Promise.reject(new Error("clinical_purge_wipe_failed"));
          }
        };
      }
      const plan = planDesktopClinicalPurge(rs, creationWorkspaceId, [...known]);
      writeClinicalPurgePending(userDataDirectory, plan); current = plan;
      return () => {
        try {
          confirmClinicalPurgePending(userDataDirectory, plan);
          wipe(userDataDirectory, { ...plan, state: "confirmed" });
          clearClinicalPurgePending(userDataDirectory, plan.recoveryScope);
          current = null; return Promise.resolve();
        } catch {
          log?.("clinical_purge_wipe_failed");
          writeMarker(userDataDirectory, { ...plan, state: "confirmed" }, "clinical_purge_wipe_failed");
          return Promise.reject(new Error("clinical_purge_wipe_failed"));
        }
      };
    },
  };
}