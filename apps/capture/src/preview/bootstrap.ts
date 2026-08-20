const BOOTSTRAP_PATH = "/api/capture/preview/bootstrap";

export interface CapturePreviewBootstrap {
  readonly mode: "synthetic";
  readonly microphoneEnabled: false;
  readonly maxChunks: 6;
}

export async function bootstrapCapturePreview(
  fetchImplementation: typeof fetch = fetch,
): Promise<CapturePreviewBootstrap | null> {
  if (import.meta.env.VITE_CAPTURE_PREVIEW_PERSISTENT_ENABLED !== "true") return null;
  const response = await fetchImplementation.call(globalThis, BOOTSTRAP_PATH, {
    method: "POST",
    credentials: "include",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error("synthetic preview bootstrap failed");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error("synthetic preview bootstrap returned an invalid content type");
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > 1_024) {
    throw new Error("synthetic preview bootstrap response was too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("synthetic preview bootstrap returned invalid JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "max_chunks,microphone_enabled,mode" ||
    !("mode" in value) ||
    value.mode !== "synthetic" ||
    !("microphone_enabled" in value) ||
    value.microphone_enabled !== false ||
    !("max_chunks" in value) ||
    value.max_chunks !== 6
  ) {
    throw new Error("synthetic preview bootstrap policy mismatch");
  }
  return { mode: "synthetic", microphoneEnabled: false, maxChunks: 6 };
}
