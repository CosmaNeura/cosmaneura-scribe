import { isAbsolute, join } from "node:path";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DurableDesktopRecordStore } from "./durable-record-store.js";

export interface DesktopClinicalScope { readonly recoveryScope: string; readonly workspaceId: string; }
export interface DesktopClinicalDirectoryScopes {
  readonly records: DesktopClinicalScope; readonly creation: DesktopClinicalScope;
}
/** Captured before Cosmas DELETE — never resolved from Core afterward. */
export interface DesktopClinicalPurgePlan {
  readonly recoveryScope: string;
  readonly recordsWorkspaceIds: readonly string[];
  readonly creationWorkspaceId: string;
}
export const CLINICAL_PURGE_PENDING_NAME = "clinical-purge-pending-v1.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const unavailable = (): Error => new Error("desktop_clinical_scope_unavailable");
const scopeUuid = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;

export function resolveDesktopClinicalDirectoryScopes(input: {
  readonly recoveryScope: unknown; readonly recordsWorkspaceId: unknown; readonly creationWorkspaceId: unknown;
}): DesktopClinicalDirectoryScopes {
  const recoveryScope = scopeUuid(input.recoveryScope);
  const recordsWorkspaceId = scopeUuid(input.recordsWorkspaceId);
  const creationWorkspaceId = scopeUuid(input.creationWorkspaceId);
  if (!recoveryScope || !recordsWorkspaceId || !creationWorkspaceId) throw unavailable();
  return {
    records: { recoveryScope, workspaceId: recordsWorkspaceId },
    creation: { recoveryScope, workspaceId: creationWorkspaceId },
  };
}

export function planDesktopClinicalPurge(
  catalog: Record<string, unknown>, creationWorkspaceId: string,
): DesktopClinicalPurgePlan {
  const recoveryScope = scopeUuid(catalog.recoveryScope), creation = scopeUuid(creationWorkspaceId);
  if (!recoveryScope || !creation) throw unavailable();
  const recordsWorkspaceIds = new Set<string>([creation]);
  if (Array.isArray(catalog.encounters)) {
    for (const row of catalog.encounters) {
      if (!row || typeof row !== "object" || !("workspaceId" in row)) continue;
      const id = scopeUuid((row as { workspaceId: unknown }).workspaceId);
      if (!id) throw unavailable();
      recordsWorkspaceIds.add(id);
    }
  }
  return { recoveryScope, creationWorkspaceId: creation, recordsWorkspaceIds: [...recordsWorkspaceIds] };
}

export function wipeDesktopClinicalDirectories(
  userDataDirectory: string, scopes: DesktopClinicalDirectoryScopes,
): void {
  if (typeof userDataDirectory !== "string" || !isAbsolute(userDataDirectory)) throw unavailable();
  DurableDesktopRecordStore.wipeAccount(
    join(userDataDirectory, "provider-records-v1"), scopes.records.recoveryScope, scopes.records.workspaceId,
  );
  DurableDesktopRecordStore.wipeAccount(
    join(userDataDirectory, "provider-creation-v1"), scopes.creation.recoveryScope, scopes.creation.workspaceId,
  );
}

export function wipeDesktopClinicalPurgePlan(userDataDirectory: string, plan: DesktopClinicalPurgePlan): void {
  for (const recordsWorkspaceId of plan.recordsWorkspaceIds) {
    wipeDesktopClinicalDirectories(userDataDirectory, resolveDesktopClinicalDirectoryScopes({
      recoveryScope: plan.recoveryScope, recordsWorkspaceId, creationWorkspaceId: plan.creationWorkspaceId,
    }));
  }
}

export function purgePendingPath(userDataDirectory: string): string {
  return join(userDataDirectory, CLINICAL_PURGE_PENDING_NAME);
}

export function writeClinicalPurgePending(
  userDataDirectory: string, plan: DesktopClinicalPurgePlan, reason?: string,
): void {
  if (!isAbsolute(userDataDirectory)) throw unavailable();
  const path = purgePendingPath(userDataDirectory), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    recoveryScope: plan.recoveryScope, creationWorkspaceId: plan.creationWorkspaceId,
    recordsWorkspaceIds: plan.recordsWorkspaceIds, ...(reason ? { reason } : {}),
  }), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function readClinicalPurgePending(userDataDirectory: string): DesktopClinicalPurgePlan | null {
  const path = purgePendingPath(userDataDirectory);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof raw.recoveryScope !== "string" || typeof raw.creationWorkspaceId !== "string"
      || !Array.isArray(raw.recordsWorkspaceIds)) return null;
    const recordsWorkspaceIds = raw.recordsWorkspaceIds.map(scopeUuid);
    if (recordsWorkspaceIds.some(id => !id)) return null;
    const recoveryScope = scopeUuid(raw.recoveryScope), creationWorkspaceId = scopeUuid(raw.creationWorkspaceId);
    if (!recoveryScope || !creationWorkspaceId) return null;
    return { recoveryScope, creationWorkspaceId, recordsWorkspaceIds: recordsWorkspaceIds as string[] };
  } catch { return null; }
}

export function clearClinicalPurgePending(userDataDirectory: string): void {
  try { const path = purgePendingPath(userDataDirectory); if (existsSync(path)) unlinkSync(path); }
  catch { /* keep marker if unlink fails */ }
}

export function retryClinicalPurgePending(
  userDataDirectory: string,
  options?: {
    readonly wipe?: (dir: string, plan: DesktopClinicalPurgePlan) => void;
    readonly log?: (reason: string) => void;
  },
): boolean {
  const plan = readClinicalPurgePending(userDataDirectory);
  if (!plan) return false;
  const wipe = options?.wipe ?? wipeDesktopClinicalPurgePlan;
  try { wipe(userDataDirectory, plan); clearClinicalPurgePending(userDataDirectory); return true; }
  catch {
    options?.log?.("clinical_purge_retry_failed");
    writeClinicalPurgePending(userDataDirectory, plan, "clinical_purge_retry_failed");
    return false;
  }
}

/** Capture validated scopes before DELETE. Wipe closure never calls Core. */
export function createDesktopClinicalPurgeHost(options: {
  readonly userDataDirectory: string; readonly creationWorkspaceId: string;
  readonly loadCatalog: () => Promise<Record<string, unknown>>;
  readonly wipe?: (dir: string, plan: DesktopClinicalPurgePlan) => void;
  readonly log?: (reason: string) => void;
}): {
  prepareClinicalPurge: () => Promise<() => Promise<void>>;
  abandonClinicalPurge: () => void; retryPendingPurge: () => boolean;
} {
  const wipe = options.wipe ?? wipeDesktopClinicalPurgePlan, log = options.log;
  return {
    abandonClinicalPurge: () => clearClinicalPurgePending(options.userDataDirectory),
    retryPendingPurge: () => retryClinicalPurgePending(options.userDataDirectory, { wipe, ...(log ? { log } : {}) }),
    prepareClinicalPurge: async () => {
      const plan = planDesktopClinicalPurge(await options.loadCatalog(), options.creationWorkspaceId);
      writeClinicalPurgePending(options.userDataDirectory, plan);
      return (): Promise<void> => {
        try {
          wipe(options.userDataDirectory, plan); clearClinicalPurgePending(options.userDataDirectory);
          return Promise.resolve();
        } catch {
          log?.("clinical_purge_wipe_failed");
          writeClinicalPurgePending(options.userDataDirectory, plan, "clinical_purge_wipe_failed");
          return Promise.reject(new Error("clinical_purge_wipe_failed"));
        }
      };
    },
  };
}
