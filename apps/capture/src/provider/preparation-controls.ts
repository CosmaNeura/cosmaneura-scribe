import { consentScript } from "./recording-preparation-view";
import { inputVerdict, type AudioPreflightSnapshot, type ProviderAudioPreflight } from "./audio-preflight";
import type { ProviderPreferences } from "./provider-preferences";

/** Owns only advisory input metadata. Close must settle before capture admission. */
export function bindPreparationControls(root: HTMLElement, options: { isIOS: boolean; signal: AbortSignal;
  open?: (signal: AbortSignal) => Promise<ProviderAudioPreflight>;
  remember(value: ProviderPreferences): void;
}): { snapshot(): AudioPreflightSnapshot | null; ready(): boolean; close(): Promise<void> } {
  const lifetime = new AbortController(), signal = lifetime.signal;
  const externalAbort = (): void => lifetime.abort();
  options.signal.addEventListener("abort", externalAbort, { once: true }); if (options.signal.aborted) lifetime.abort();
  let port: ProviderAudioPreflight | null = null, snapshot: AudioPreflightSnapshot | null = null;
  let selecting = false, closed = false, unsubscribe: (() => void) | undefined, closing: Promise<void> | null = null;
  const select = (selector: string): HTMLSelectElement => root.querySelector<HTMLSelectElement>(selector)!;
  const value = (name: string): string => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";
  const ready = (): boolean => !closed && !selecting && (!options.open || snapshot?.status === "ready")
    && (options.isIOS || value("desktop-audio") !== "meeting" || snapshot?.desktopAudio === "meeting" && !!snapshot.meetingWindows?.selectedId);
  const paint = (): void => {
    if (closed || signal.aborted) return;
    const video = !options.isIOS && value("desktop-audio") === "meeting";
    const start = root.querySelector<HTMLButtonElement>('[data-workspace-action="prepare"]')!;
    start.disabled = !root.querySelector<HTMLInputElement>('[name="consent"]')?.checked || !ready();
    root.querySelector<HTMLElement>("[data-consent-script]")!.textContent = `“${consentScript(value("language") !== "en-US", video)}”`;
    const device = snapshot?.inputDevices.find(input => input.id === snapshot?.selectedInputId);
    root.querySelector<HTMLElement>("[data-audio-summary]")!.textContent = `${value("language") === "en-US" ? "English" : "Spanish and English · note in English"} · ${device?.label ?? "Microphone"}`;
    for (const choice of root.querySelectorAll<HTMLButtonElement>("[data-preparation-audio]")) choice.setAttribute("aria-pressed", String(choice.dataset.preparationAudio === value("desktop-audio")));
    root.querySelector<HTMLElement>("[data-recording-guidance]")!.textContent = video ? "Choose the call before recording. Close unrelated audio in that app." : "Keep both voices near the microphone.";
    root.querySelector<HTMLElement>("[data-preflight-verdict]")!.textContent = snapshot?.status === "permission_required" ? "Microphone access is needed. Allow it in device settings."
      : snapshot?.status === "unavailable" ? "Microphone check unavailable. Check recording access, then reopen this visit."
      : !options.open ? "Microphone access will be checked before recording." : inputVerdict(snapshot?.microphone ?? null);
    root.querySelector<HTMLElement>("[data-preflight-level]")!.style.width = `${snapshot?.microphone && snapshot.microphone.ageMs <= 1500 ? Math.min(100, snapshot.microphone.level * 100) : 0}%`;
    const inputs = select("[data-preflight-input]");
    const devices = snapshot?.inputDevices ?? [];
    const signature = JSON.stringify(devices.map(row => [row.id, row.label]));
    if (inputs.dataset.devices !== signature) {
      inputs.replaceChildren(...devices.map(row => new Option(row.label, row.id)));
      if (!devices.length) inputs.add(new Option("No microphone available", ""));
      inputs.dataset.devices = signature;
    }
    inputs.value = snapshot?.selectedInputId ?? ""; inputs.disabled = !port || selecting || !devices.length;
    const meeting = root.querySelector<HTMLElement>("[data-preflight-meeting]");
    if (meeting) {
      meeting.hidden = !video;
      const windows = select("[data-preflight-window]"), catalog = snapshot?.meetingWindows;
      const signature = JSON.stringify(catalog?.windows ?? []);
      if (windows.dataset.windows !== signature) {
        windows.replaceChildren(new Option("Choose your Zoom or Chrome window", ""), ...(catalog?.windows ?? []).map(row => new Option(row.title, row.id)));
        windows.dataset.windows = signature;
      }
      windows.value = catalog?.selectedId ?? ""; windows.disabled = selecting || !port;
      root.querySelector<HTMLElement>("[data-preflight-window-help]")!.textContent = catalog?.state === "unavailable" ? "Calls could not be loaded. Check recording access and refresh."
        : catalog?.windows.length ? "Records your microphone and audio from this application." : "Open the visit in Zoom or Chrome, then refresh calls.";
    }
  };
  const remember = (): void => options.remember({ language: value("language") as ProviderPreferences["language"],
    modality: value("modality") as ProviderPreferences["modality"], audio: options.isIOS ? "microphone" : value("desktop-audio") as ProviderPreferences["audio"] });
  const apply = async (operation: () => Promise<void>): Promise<void> => {
    if (selecting || !port || closed) return;
    selecting = true; paint();
    try { await operation(); if (!closed) snapshot = port.getSnapshot(); }
    catch { if (!closed) snapshot = { ...(snapshot ?? { inputDevices: [], selectedInputId: null }), status: "unavailable", microphone: null }; }
    finally { selecting = false; paint(); }
  };
  const changed = (event: Event): void => {
    if (event.target === root.querySelector("[data-preflight-input]")) { const id = select("[data-preflight-input]").value; void apply(() => port!.selectMicrophone(id)); }
    else if (event.target === root.querySelector("[data-preflight-window]")) { const id = select("[data-preflight-window]").value; void apply(() => port!.selectMeetingWindow!(id)); }
    else { remember(); paint(); }
  };
  const clicked = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-change-audio], [data-audio-done], [data-preparation-audio], [data-preflight-refresh]") : null;
    if (!button || closed) return;
    const dialog = root.querySelector<HTMLDialogElement>("[data-audio-settings]")!;
    if (button.hasAttribute("data-change-audio")) dialog.showModal();
    else if (button.hasAttribute("data-audio-done")) { dialog.close(); root.querySelector<HTMLButtonElement>("[data-change-audio]")?.focus(); }
    else if (button.hasAttribute("data-preflight-refresh")) void apply(() => port!.refreshMeetingWindows!());
    else {
      const mode = button.dataset.preparationAudio as "microphone" | "meeting";
      select('[name="desktop-audio"]').value = mode; select('[name="modality"]').value = mode === "meeting" ? "virtual" : "in_person";
      remember(); paint(); if (port?.selectDesktopAudio) void apply(() => port!.selectDesktopAudio!(mode));
    }
  };
  root.addEventListener("change", changed); root.addEventListener("click", clicked); paint();
  const opening = options.open ? options.open(signal).then(async opened => {
    port = opened;
    if (closed || signal.aborted) { await opened.close(); return; }
    unsubscribe = opened.subscribe(value => { snapshot = value; paint(); });
    if (!options.isIOS && opened.selectDesktopAudio) await apply(() => opened.selectDesktopAudio!(value("desktop-audio") as "microphone" | "meeting"));
  }).catch(() => { if (!closed) { snapshot = { status: "unavailable", inputDevices: [], selectedInputId: null, microphone: null }; paint(); } }) : Promise.resolve();
  const close = (): Promise<void> => {
    closed = true; options.signal.removeEventListener("abort", externalAbort); lifetime.abort(); unsubscribe?.(); root.removeEventListener("change", changed); root.removeEventListener("click", clicked);
    root.querySelector<HTMLDialogElement>("[data-audio-settings]")?.close();
    return closing ??= opening.then(() => port?.close()).then(() => undefined).catch(error => { closing = null; throw error; });
  };
  return { snapshot: () => snapshot, ready, close };
}
