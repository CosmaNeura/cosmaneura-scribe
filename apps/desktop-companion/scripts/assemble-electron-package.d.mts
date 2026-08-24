export interface AssemblyRequest {
  readonly target: "darwin-arm64" | "win32-x64";
  readonly electronZip: string;
  readonly out: string;
  readonly sourceSha: string;
}

export interface AssemblyTarget {
  readonly archive?: {
    readonly filename: string;
    readonly sha256: string;
  };
  readonly arch: "arm64" | "x64";
  readonly platform: "darwin" | "win32";
  readonly target?: "darwin-arm64" | "win32-x64";
}

export function parseArguments(values: readonly string[]): AssemblyRequest;
export function hashTree(root: string): Promise<string>;
export function isSafeLockPath(path: string): boolean;
export function isWithin(root: string, candidate: string): boolean;
export function verifyAsarIntegrityHeader(header: unknown): void;
export function selectPackagerExport(loaded: unknown): (...args: unknown[]) => unknown;
export function createPackagerOptions(input: {
  readonly electronZip: string;
  readonly outputRoot: string;
  readonly packagerTemporaryRoot: string;
  readonly stagingRoot: string;
  readonly target: AssemblyTarget;
}): Readonly<Record<string, unknown>>;
