import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RENDERER_CONTENT_SECURITY_POLICY } from "./electron-security.js";

export const PROVIDER_ENTRY = "app://cosmas/provider.html";
export const PROVIDER_ASSETS = Object.freeze({
  "provider.html": "text/html; charset=utf-8",
  "desktop-start.js": "text/javascript; charset=utf-8",
  "provider-capture.js": "text/javascript; charset=utf-8",
  "provider-capture.css": "text/css; charset=utf-8",
});
type Name = keyof typeof PROVIDER_ASSETS;
export interface PackagedProvider {
  allows(url: string): boolean;
  respond(request: { readonly url: string; readonly method: string }): Response;
}

/** Load only the four build-generated renderer assets before exposing a window.
 * The manifest detects mismatched build inputs; package signing is separate. */
export async function loadPackagedProvider(directory: string): Promise<PackagedProvider> {
  if (!isAbsolute(directory) || await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw invalid();
  const manifest = JSON.parse((await readRegular(join(directory, "renderer-manifest.json"), 4096)).toString("utf8")) as unknown;
  if (!record(manifest) || Object.keys(manifest).sort().join(",") !== "files,schema" || manifest.schema !== 1
    || !record(manifest.files) || Object.keys(manifest.files).sort().join(",") !== Object.keys(PROVIDER_ASSETS).sort().join(",")) throw invalid();
  const assets = new Map<string, { bytes: Uint8Array; type: string }>();
  for (const name of Object.keys(PROVIDER_ASSETS) as Name[]) {
    const expected = manifest.files[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) throw invalid();
    const bytes = await readRegular(join(directory, name), 4 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw invalid();
    assets.set(`app://cosmas/${name}`, { bytes: new Uint8Array(bytes), type: PROVIDER_ASSETS[name] });
  }
  return Object.freeze({
    allows: (url: string) => assets.has(url),
    respond: (request: { readonly url: string; readonly method: string }) => {
      const asset = assets.get(request.url);
      if (request.method !== "GET" || !asset) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(asset.bytes), { headers: {
        "Content-Type": asset.type, "Content-Security-Policy": RENDERER_CONTENT_SECURITY_POLICY,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
      } });
    },
  });
}
async function readRegular(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw invalid();
  const bytes = await readFile(path); if (bytes.length > limit) throw invalid(); return bytes;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(): Error { return new Error("The packaged Scribe workspace could not be verified."); }
