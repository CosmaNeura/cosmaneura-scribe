import type { LanguageMode } from "./core-client";

export interface ProviderPreferences {
  language: LanguageMode;
  modality: "in_person" | "virtual" | "phone";
  audio: "microphone" | "meeting";
}

/** Only nonclinical settings persist here. Account names and patient data never do. */
export async function providerPreferences(account: string | undefined): Promise<{
  value: ProviderPreferences | null; save(value: ProviderPreferences): void;
}> {
  if (!account) return { value: null, save: () => undefined };
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account));
    const key = "scribe-preferences-v1:" + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    const value = valid(data) ? data : null;
    return { value, save: next => { if (valid(next)) try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Settings remain usable in this app lifetime. */ } } };
  } catch { return { value: null, save: () => undefined }; }
}
function valid(value: unknown): value is ProviderPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "audio,language,modality"
    && ["en-US", "en-US+es-US"].includes(String(row.language))
    && ["in_person", "virtual", "phone"].includes(String(row.modality))
    && ["microphone", "meeting"].includes(String(row.audio));
}
