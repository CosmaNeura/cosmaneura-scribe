import { consentScript } from "./recording-preparation-view";
import { type AudioPreflightSnapshot, type ProviderAudioPreflight } from "./audio-preflight";
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
  let failed = false;
  let selecting = false, closed = false, unsubscribe: (() => void) | undefined, closing: Promise<void> | null = null;
  const select = (selector: string): HTMLSelectElement => root.querySelector<HTMLSelectElement>(selector)!;
  const value = (name: string): string => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";
  const ready = (): boolean => !closed && !selecting && (!options.open || snapshot?.status === "ready")
    && (!options.open || options.isIOS || snapshot?.desktopAudio === value("desktop-audio"))
    && (options.isIOS || value("desktop-audio") !== "meeting" || snapshot?.desktopAudio === "meeting" && snapshot.meetingWindows?.state === "ready" && !!snapshot.meetingWindows.selectedId);
  const paint = (): void => {
    if (closed || signal.aborted) return;
    const video = !options.isIOS && value("desktop-audio") === "meeting";
    const start = root.querySelector<HTMLButtonElement>('[data-workspace-action="prepare"]')!;
    start.disabled = !root.querySelector<HTMLInputElement>('[name="consent"]')?.checked || !ready();
    root.querySelector<HTMLElement>("[data-consent-script]")!.textContent = `“${consentScript(value("language") !== "en-US", video)}”`;
    const device = snapshot?.inputDevices.find(input => input.id === snapshot?.selectedInputId);
    const deferredIOSInput = options.isIOS && snapshot?.status === "ready" && !snapshot.inputDevices.length;
    root.querySelector<HTMLElement>("[data-audio-summary]")!.textContent = `${value("language") === "en-US" ? "English" : "Spanish and English · note in English"} · ${device?.label ?? (deferredIOSInput ? "System microphone" : "Microphone")}`;
    for (const choice of root.querySelectorAll<HTMLButtonElement>("[data-preparation-audio]")) {
      choice.setAttribute("aria-pressed", String(choice.dataset.preparationAudio === value("desktop-audio")));
      choice.disabled = selecting || !!options.open && !port;
    }
    root.querySelector<HTMLElement>("[data-recording-guidance]")!.textContent = video ? "Choose the call before recording. Close unrelated audio in that app." : "Keep both voices near the microphone.";
    root.querySelector<HTMLElement>("[data-preflight-verdict]")!.textContent = snapshot?.status === "permission_required" ? "Microphone access is needed. Check recording access, then allow Scribe in device settings."
      : snapshot?.status === "unavailable" ? "Microphone unavailable. Check recording access and choose an available microphone."
      : selecting || snapshot?.status === "checking" ? "Checking recording access…"
      : !options.open ? "Microphone access will be checked before recording."
      : deferredIOSInput ? "System microphone — checked at start. Not listening yet." : "Microphone selected. Not listening yet.";
    const access = root.querySelector<HTMLButtonElement>("[data-preflight-access]")!;
    access.hidden = !port?.requestRecordingAccess; access.disabled = selecting || !port;
    root.querySelector<HTMLElement>("[data-preflight-access-help]")!.textContent = video && snapshot?.meetingWindows?.state === "permission_required"
      ? "Screen Recording access is needed. If Scribe Desktop is already enabled, turn it off and on in System Settings → Privacy & Security → Screen Recording, reopen Scribe if macOS asks, then check again."
      : failed ? "The check did not complete. Review recording access in device settings, then check again. No recording has started."
      : "Microphone levels appear after consent and recording starts.";
    const inputs = select("[data-preflight-input]");
    const devices = snapshot?.inputDevices ?? [];
    const signature = JSON.stringify(devices.map(row => [row.id, row.label]));
    if (inputs.dataset.devices !== signature) {
      inputs.replaceChildren(...devices.map(row => new Option(row.label, row.id)));
      if (!devices.length) inputs.add(new Option(deferredIOSInput ? "System microphone — checked at start" : "No microphone available", ""));
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
      root.querySelector<HTMLElement>("[data-preflight-window-help]")!.textContent = catalog?.state === "permission_required" ? "Screen Recording access is needed. Check recording access before choosing a call."
        : catalog?.state === "unavailable" ? "Calls could not be loaded. Refresh calls or check recording access."
        : catalog?.windows.length ? "Records your microphone and audio from this application." : "Open the visit in Zoom or Chrome, then refresh calls.";
    }
  };
  const remember = (): void => options.remember({ language: value("language") as ProviderPreferences["language"],
    modality: value("modality") as ProviderPreferences["modality"], audio: options.isIOS ? "microphone" : value("desktop-audio") as ProviderPreferences["audio"] });
  const apply = async (operation: () => Promise<void>): Promise<void> => {
    if (selecting || !port || closed) return;
    selecting = true; failed = false; paint();
    try { await operation(); if (!closed) snapshot = port.getSnapshot(); }
    catch { if (!closed) { failed = true; snapshot = port.getSnapshot(); } }
    finally { selecting = false; paint(); }
  };
  const changed = (event: Event): void => {
    if (event.target === root.querySelector("[data-preflight-input]")) { const id = select("[data-preflight-input]").value; void apply(() => port!.selectMicrophone(id)); }
    else if (event.target === root.querySelector("[data-preflight-window]")) { const id = select("[data-preflight-window]").value; void apply(() => port!.selectMeetingWindow!(id)); }
    else { remember(); paint(); }
  };
  const clicked = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-change-audio], [data-audio-done], [data-preparation-audio], [data-preflight-refresh], [data-preflight-access]") : null;
    if (!button || closed) return;
    const dialog = root.querySelector<HTMLDialogElement>("[data-audio-settings]")!;
    if (button.hasAttribute("data-change-audio")) dialog.showModal();
    else if (button.hasAttribute("data-audio-done")) { dialog.close(); root.querySelector<HTMLButtonElement>("[data-change-audio]")?.focus(); }
    else if (button.hasAttribute("data-preflight-access")) void apply(() => port!.requestRecordingAccess!());
    else if (button.hasAttribute("data-preflight-refresh")) void apply(() => port!.refreshMeetingWindows!());
    else {
      if (selecting) return;
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
