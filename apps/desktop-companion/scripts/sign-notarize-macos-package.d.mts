export interface MacosSigningRequest {
  readonly application: string;
  readonly hardeningReceipt: string;
  readonly identitySha1: string;
  readonly keychain: string;
  readonly notaryProfile: string;
  readonly out: string;
  readonly sourceSha: string;
}

export interface MacosSigningInventory {
  readonly codePaths: readonly string[];
  readonly discoveredCodeObjects: number;
  readonly ignoredProvenanceArchives: readonly string[];
}

export function parseArguments(values: readonly string[]): MacosSigningRequest;
export function isIgnoredProvenanceArchive(
  applicationPath: string,
  path: string,
): boolean;
export function isRecallRuntimeCode(
  applicationPath: string,
  path: string,
): boolean;
export function verifySigningInventory(
  applicationPath: string,
  walk: (contentsPath: string) => Promise<string[]>,
): Promise<MacosSigningInventory>;
