import { posix, win32 } from "node:path";

/** A tar archive may contain one metadata-only current-directory entry. */
export function isRecallNativeArchiveRootDirectory(archivePath, linkTarget) {
  return (
    (archivePath === "." || archivePath === "./") && linkTarget === undefined
  );
}

/**
 * Normalize one native archive entry while rejecting POSIX and Windows
 * traversal. This function is shared by preparation and runtime verification.
 */
export function normalizeRecallNativeArchiveEntry(
  archivePath,
  linkTarget,
  allowedRoots,
) {
  if (
    typeof archivePath !== "string" ||
    (linkTarget !== undefined && typeof linkTarget !== "string") ||
    archivePath.includes("\0") ||
    linkTarget?.includes("\0") === true
  ) {
    throw new Error("Recall native archive contains an unsafe path");
  }
  const normalized = normalizeSeparators(archivePath);
  const root = normalized.split("/")[0] ?? "";
  if (
    isAbsoluteOrDriveQualified(archivePath) ||
    isAbsoluteOrDriveQualified(normalized) ||
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !allowedRoots.includes(root)
  ) {
    throw new Error("Recall native archive contains an unsafe path");
  }
  if (linkTarget !== undefined) {
    const normalizedLink = normalizeSeparators(linkTarget);
    const target = posix.normalize(
      posix.join(posix.dirname(normalized), normalizedLink),
    );
    if (
      isAbsoluteOrDriveQualified(linkTarget) ||
      isAbsoluteOrDriveQualified(normalizedLink) ||
      target === ".." ||
      target.startsWith("../") ||
      !allowedRoots.includes(target.split("/")[0] ?? "")
    ) {
      throw new Error("Recall native archive contains an unsafe link");
    }
  }
  return normalized;
}

function normalizeSeparators(value) {
  return posix.normalize(value.replaceAll("\\", "/"));
}

function isAbsoluteOrDriveQualified(value) {
  return (
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  );
}
