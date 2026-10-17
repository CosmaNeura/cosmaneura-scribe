import { consentScript } from "./recording-preparation-view";
import { type AudioPreflightSnapshot, type ProviderAudioPreflight } from "./audio-preflight";
import type { ProviderPreferences } from "./provider-preferences";

/** Owns only advisory input metadata. Close must settle before capture admission. */
export function bindPreparationControls(root: HTMLElement, options: { isIOS: boolean; signal: AbortSignal;
  open?: (signal: AbortSignal) => Promise<ProviderAudioPreflight>;
  remember(value: ProviderPreferences): void;
  /** Fresh checkbox action only; advisory readiness changes never replay consent. */
  onConsent?: () => void;
}): { snapshot(): AudioPreflightSnapshot | null; ready(): boolean; close(): Promise<void> } {
  const lifetime = new AbortController(), signal = lifetime.signal;
  const externalAbort = (): void => lifetime.abort();
  options.signal.addEventListener("abort", externalAbort, { once: true }); if (options.signal.aborted) lifetime.abort();
  let port: ProviderAudioPreflight | null = null, snapshot: AudioPreflightSnapshot | null = null;
  let failed = false;
  let consentChecked = false;
  let selecting = false, windowPickerOpen = false, closed = false, unsubscribe: (() => void) | undefined, closing: Promise<void> | null = null;
  const select = (selector: string): HTMLSelectElement => root.querySelector<HTMLSelectElement>(selector)!;
  const value = (name: string): string => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";
  const ready = (): boolean => {
    const catalog = snapshot?.meetingWindows;
    return !closed && !selecting && !failed && (!options.open || snapshot?.status === "ready")
      && (!options.open || options.isIOS || snapshot?.desktopAudio === value("desktop-audio"))
      && (options.isIOS || value("desktop-audio") !== "meeting" || !windowPickerOpen && snapshot?.desktopAudio === "meeting" && catalog?.state === "ready"
        && catalog.windows.some(window => window.id === catalog.selectedId));
  };
  const paint = (): void => {
    if (closed || signal.aborted) return;
    const video = !options.isIOS && value("desktop-audio") === "meeting";
    const start = root.querySelector<HTMLButtonElement>('[data-workspace-action="prepare"]')!;
    start.disabled = !root.querySelector<HTMLInputElement>('[name="consent"]')?.checked || !ready();
    if (options.onConsent) root.querySelector<HTMLInputElement>('[name="consent"]')!.disabled = !ready();
    root.querySelector<HTMLElement>("[data-consent-script]")!.textContent = `“${consentScript(value("language") !== "en-US", video)}”`;
    const device = snapshot?.inputDevices.find(input => input.id === snapshot?.selectedInputId);
    const deferredIOSInput = options.isIOS && snapshot?.status === "ready" && !snapshot.inputDevices.length;
    root.querySelector<HTMLElement>("[data-audio-summary]")!.textContent = `${value("language") === "en-US" ? "English" : "Spanish and English · note in English"} · ${device?.label ?? (deferredIOSInput ? "System microphone" : "Microphone")}`;
    for (const choice of root.querySelectorAll<HTMLButtonElement>("[data-preparation-audio]")) {
      choice.setAttribute("aria-pressed", String(choice.dataset.preparationAudio === value("desktop-audio")));
      choice.disabled = selecting || !!options.open && !port;
    }
    root.querySelector<HTMLElement>("[data-recording-guidance]")!.textContent = video
      ? "Records your microphone and the call app’s audio. Chrome may include other tabs; pause videos or music."
      : "Keep both voices near the microphone.";
    const screenNeeded = video && snapshot?.meetingWindows?.state === "permission_required";
    const requiredAccess = failed || screenNeeded || snapshot?.status === "permission_required" || snapshot?.status === "unavailable";
    root.querySelector<HTMLElement>("[data-preflight-verdict]")!.textContent = selecting || snapshot?.status === "checking" ? "Checking recording access…"
      : failed ? "Recording access check did not complete."
      : screenNeeded ? "Screen Recording access is needed."
      : snapshot?.status === "permission_required" ? "Microphone access is needed."
      : snapshot?.status === "unavailable" ? port ? "Microphone unavailable." : "Recording access could not be checked."
      : !options.open ? "Microphone access is checked when recording starts."
      : ready() ? "Ready to start. Not listening yet." : "Microphone ready. Not listening yet.";
    const access = root.querySelector<HTMLButtonElement>("[data-preflight-access]")!;
    const optionalAccess = root.querySelector<HTMLButtonElement>("[data-preflight-access-optional]")!;
    access.hidden = !port?.requestRecordingAccess; access.disabled = selecting || !port;
    optionalAccess.hidden = !port?.requestRecordingAccess || requiredAccess; optionalAccess.disabled = selecting || !port;
    root.querySelector<HTMLElement>("[data-preflight-required-access]")!.hidden = !requiredAccess;
    const accessHelp = root.querySelector<HTMLElement>("[data-preflight-access-help]")!;
    accessHelp.textContent = failed ? "The check did not complete. Try again. No recording has started."
      : !port ? "Choose Back, then reopen this visit to try again."
      : screenNeeded || snapshot?.status === "permission_required" ? "Choose Check recording access to allow Scribe."
      : "Connect a microphone, then choose it under Change.";
    const repair = root.querySelector<HTMLDetailsElement>("[data-preflight-repair]")!;
    const steps = screenNeeded ? [
      "Open System Settings → Privacy & Security → Screen Recording.",
      "Allow Scribe Desktop. If it is already on, turn it off and on.",
      "Reopen Scribe if macOS asks, then choose Check recording access.",
    ] : snapshot?.status === "permission_required" ? options.isIOS ? [
      "Open Settings on this iPhone.", "Allow Microphone access for Scribe.", "Return to Scribe, then choose Check recording access.",
    ] : [
      "Open System Settings → Privacy & Security → Microphone.", "Allow Scribe Desktop.", "Return to Scribe, then choose Check recording access.",
    ] : [];
    repair.hidden = !steps.length;
    root.querySelector<HTMLOListElement>("[data-preflight-repair-steps]")!.replaceChildren(...steps.map(text => {
      const item = root.ownerDocument.createElement("li"); item.textContent = text; return item;
    }));
    root.querySelector<HTMLElement>("[data-preflight-details-help]")!.textContent = deferredIOSInput
      ? "This iPhone’s microphone is checked when recording starts. Microphone levels appear only after consent and Start recording."
      : "Microphone levels appear only after consent and Start recording. You can check access again without recording.";
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
      const selected = snapshot?.desktopAudio === "meeting" && catalog?.state === "ready"
        ? catalog.windows.find(window => window.id === catalog.selectedId) : undefined;
      const signature = JSON.stringify(catalog?.windows ?? []);
      if (windows.dataset.windows !== signature) {
        windows.replaceChildren(new Option("Choose your Zoom or Chrome window", ""), ...(catalog?.windows ?? []).map(row => new Option(row.title, row.id)));
        windows.dataset.windows = signature;
      }
      windows.value = selected?.id ?? ""; windows.disabled = selecting || !port;
      root.querySelector<HTMLElement>("[data-preflight-call-heading]")!.textContent = selected ? "Call selected" : "Choose your call";
      root.querySelector<HTMLElement>("[data-preflight-call-title]")!.textContent = selected?.title ?? (catalog?.state === "ready" && catalog.windows.length ? "Choose the visit you want to record." : "");
      const change = root.querySelector<HTMLButtonElement>("[data-preflight-call-change]")!;
      change.textContent = selected ? "Change" : "Choose call";
      change.disabled = selecting || !port; change.setAttribute("aria-expanded", String(windowPickerOpen));
      root.querySelector<HTMLElement>("[data-preflight-call-picker]")!.hidden = !windowPickerOpen;
      root.querySelector<HTMLButtonElement>("[data-preflight-call-done]")!.disabled = selecting;
      root.querySelector<HTMLButtonElement>("[data-preflight-refresh]")!.disabled = selecting || !port;
      const windowHelp = root.querySelector<HTMLElement>("[data-preflight-window-help]")!;
      windowHelp.hidden = !!selected;
      windowHelp.textContent = catalog?.state === "permission_required" ? "Allow access before choosing your call."
        : catalog?.state === "unavailable" ? "Calls could not be loaded. Choose call to refresh the list."
        : selecting || snapshot?.status === "checking" ? "Checking your calls…"
        : selected ? ""
        : catalog?.windows.length ? "Choose a call, then confirm the patient's consent." : "Open the visit in Zoom or Chrome, then choose call to refresh.";
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
    if (event.target === root.querySelector('[name="consent"]')) {
      const checked = root.querySelector<HTMLInputElement>('[name="consent"]')!.checked;
      const fresh = checked && !consentChecked; consentChecked = checked;
      paint();
      if (fresh && ready()) options.onConsent?.();
    }
    else if (event.target === root.querySelector("[data-preflight-input]")) { const id = select("[data-preflight-input]").value; void apply(() => port!.selectMicrophone(id)); }
    else if (event.target === root.querySelector("[data-preflight-window]")) {
      const id = select("[data-preflight-window]").value;
      void apply(async () => { await port!.selectMeetingWindow!(id); windowPickerOpen = false; }).then(() => {
        if (!closed && !windowPickerOpen) root.querySelector<HTMLButtonElement>("[data-preflight-call-change]")?.focus();
      });
    }
    else { remember(); paint(); }
  };
  const clicked = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-change-audio], [data-audio-done], [data-preparation-audio], [data-preflight-refresh], [data-preflight-access], [data-preflight-access-optional], [data-preflight-call-change], [data-preflight-call-done]") : null;
    if (!button || closed) return;
    const dialog = root.querySelector<HTMLDialogElement>("[data-audio-settings]")!;
    if (button.hasAttribute("data-change-audio")) dialog.showModal();
    else if (button.hasAttribute("data-audio-done")) { dialog.close(); root.querySelector<HTMLButtonElement>("[data-change-audio]")?.focus(); }
    else if (button.hasAttribute("data-preflight-call-change")) { if (!selecting) { windowPickerOpen = true; paint(); select("[data-preflight-window]").focus(); } }
    else if (button.hasAttribute("data-preflight-call-done")) { if (!selecting) { windowPickerOpen = false; paint(); root.querySelector<HTMLButtonElement>("[data-preflight-call-change]")?.focus(); } }
    else if (button.hasAttribute("data-preflight-access") || button.hasAttribute("data-preflight-access-optional")) void apply(() => port!.requestRecordingAccess!()).then(() => {
      if (closed || signal.aborted || failed || snapshot?.status !== "ready") return;
      // Granted access makes the direct setup action disappear. Keep keyboard
      // focus on the next visible control without starting or consenting.
      if (ready()) root.querySelector<HTMLElement>(root.querySelector<HTMLInputElement>('[name="consent"]')!.checked
        ? '[data-workspace-action="prepare"]' : '[name="consent"]')?.focus();
      else root.querySelector<HTMLButtonElement>("[data-preflight-call-change]")?.focus();
    });
    else if (button.hasAttribute("data-preflight-refresh")) void apply(() => port!.refreshMeetingWindows!());
    else {
      if (selecting) return;
      windowPickerOpen = false;
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
