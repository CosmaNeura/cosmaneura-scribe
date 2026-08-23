export function isRecallNativeArchiveRootDirectory(
  archivePath: string,
  linkTarget: string | undefined,
): boolean;

export function normalizeRecallNativeArchiveEntry(
  archivePath: string,
  linkTarget: string | undefined,
  allowedRoots: readonly string[],
): string;
