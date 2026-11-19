import { isAbsolute, join } from "node:path";
import { DurableDesktopRecordStore } from "./durable-record-store.js";

export interface DesktopClinicalScope {
  readonly recoveryScope: string;
  readonly workspaceId: string;
}
export interface DesktopClinicalDirectoryScopes {
  readonly records: DesktopClinicalScope;
  readonly creation: DesktopClinicalScope;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function resolveDesktopClinicalDirectoryScopes(input: {
  readonly recoveryScope: unknown; readonly recordsWorkspaceId: unknown; readonly creationWorkspaceId: unknown;
}): DesktopClinicalDirectoryScopes {
  const recoveryScope = scopeUuid(input.recoveryScope);
  const recordsWorkspaceId = scopeUuid(input.recordsWorkspaceId);
  const creationWorkspaceId = scopeUuid(input.creationWorkspaceId);
  if (!recoveryScope || !recordsWorkspaceId || !creationWorkspaceId) {
    throw new Error("desktop_clinical_scope_unavailable");
  }
  return {
    records: { recoveryScope, workspaceId: recordsWorkspaceId },
    creation: { recoveryScope, workspaceId: creationWorkspaceId },
  };
}

export function wipeDesktopClinicalDirectories(
  userDataDirectory: string, scopes: DesktopClinicalDirectoryScopes,
): void {
  if (typeof userDataDirectory !== "string" || !isAbsolute(userDataDirectory)) {
    throw new Error("desktop_clinical_scope_unavailable");
  }
  DurableDesktopRecordStore.wipeAccount(
    join(userDataDirectory, "provider-records-v1"),
    scopes.records.recoveryScope, scopes.records.workspaceId,
  );
  DurableDesktopRecordStore.wipeAccount(
    join(userDataDirectory, "provider-creation-v1"),
    scopes.creation.recoveryScope, scopes.creation.workspaceId,
  );
}

function scopeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
