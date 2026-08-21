import { isAbsolute, resolve, sep } from "node:path";

const RENDERER_ASSETS = Object.freeze({
  "/": Object.freeze({ file: "index.html", contentType: "text/html; charset=utf-8" }),
  "/index.html": Object.freeze({ file: "index.html", contentType: "text/html; charset=utf-8" }),
  "/renderer.js": Object.freeze({ file: "renderer.js", contentType: "text/javascript; charset=utf-8" }),
  "/styles.css": Object.freeze({ file: "styles.css", contentType: "text/css; charset=utf-8" }),
});

export interface RendererAsset {
  readonly path: string;
  readonly contentType: string;
}

/** Resolve only the three packaged renderer assets; no URL-controlled path joins occur. */
export function resolvePackagedRendererAsset(
  requestUrl: string,
  rendererRoot: string,
): RendererAsset | null {
  if (!isAbsolute(rendererRoot)) {
    throw new Error("Packaged renderer root must be absolute");
  }
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "app:" ||
    parsed.hostname !== "cosmas" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }

  const asset = RENDERER_ASSETS[parsed.pathname as keyof typeof RENDERER_ASSETS];
  if (asset === undefined) {
    return null;
  }
  const path = resolve(rendererRoot, asset.file);
  const rootPrefix = rendererRoot.endsWith(sep) ? rendererRoot : `${rendererRoot}${sep}`;
  if (!path.startsWith(rootPrefix)) {
    throw new Error("Packaged renderer asset escaped its root");
  }
  return Object.freeze({ path, contentType: asset.contentType });
}
