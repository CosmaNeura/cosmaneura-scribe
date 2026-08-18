import type { ManifestTransform } from "workbox-build";

const POLICY_ORIGIN = "https://capture-preview.invalid";
const NON_CACHEABLE_PATH_PREFIXES = ["/api/", "/mock-upload/"] as const;

export const NAVIGATION_FALLBACK_DENYLIST = [
  /^\/api(?:\/|$)/u,
  /^\/mock-upload(?:\/|$)/u,
];

/**
 * Keep the generated service worker limited to immutable, same-origin build assets.
 * API responses, upload capabilities, queue records, and IndexedDB contents are runtime
 * custody and must never become Workbox precache entries.
 */
export const enforceStaticPrecache: ManifestTransform = (entries) =>
  Promise.resolve().then(() => {
    for (const entry of entries) {
      if (entry.url.startsWith("//") || hasScheme(entry.url)) {
        throw new Error("PWA precache entries must be exact-origin relative URLs");
      }
      const url = new URL(entry.url, POLICY_ORIGIN);
      if (
        url.origin !== POLICY_ORIGIN ||
        url.search !== "" ||
        url.hash !== "" ||
        NON_CACHEABLE_PATH_PREFIXES.some(
          (prefix) =>
            url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix),
        )
      ) {
        throw new Error("PWA precache contains a non-cacheable network path");
      }
    }
    return { manifest: entries, warnings: [] };
  });

function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/iu.test(value);
}
