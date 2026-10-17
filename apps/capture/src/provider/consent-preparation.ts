import type { MicrophoneInput } from "../native/microphone-input";
import type { ProviderRecorderController, ProviderRecorderSnapshot } from "../provider-binding";

/** Trusted host release control. Missing, expired or malformed controls are off. */
export interface ConsentPreparationRelease {
  readonly enabled: boolean;
  readonly owner: "John Clemente";
  readonly cohort: "internal" | "shawn-pilot";
  readonly expires: "2026-11-01";
}
export function consentPreparationEnabled(value: ConsentPreparationRelease | undefined, now = Date.now()): boolean {
  return value?.enabled === true && value.owner === "John Clemente"
    && ["internal", "shawn-pilot"].includes(value.cohort) && value.expires === "2026-11-01"
    && Number.isFinite(now) && now < Date.parse("2026-11-01T00:00:00Z");
}

/** Current consent's source configuration only. There is no recording intent. */
export interface ConsentedSourceChoice {
  readonly microphone: MicrophoneInput;
  readonly inputId?: string;
  readonly desktopAudio?: "microphone" | "meeting";
  readonly meetingWindowId?: string;
  readonly signal: AbortSignal;
}
function empty(snapshot: ProviderRecorderSnapshot): boolean {
  return snapshot.state === "ready" && snapshot.recordedChunks === 0 && snapshot.elapsedSeconds === 0
    && (!snapshot.desktop || snapshot.desktop.coverage === "not_started"
      && ["ready", "permission_required"].includes(snapshot.desktop.phase));
}

/** Applies configuration after secure preparation. Never calls Start/Resume or
 * an element continuation that could create recording intent on older hosts. */
export async function configureConsentedRecorder(controller: ProviderRecorderController, choice: ConsentedSourceChoice,
  current: () => boolean): Promise<boolean> {
  const valid = (): boolean => !choice.signal.aborted && current();
  const sessionId = controller.snapshot.sessionId;
  if (!valid()) return false;
  if (controller.snapshot.state === "preparing" || controller.snapshot.desktop?.phase === "preparing") {
    await new Promise<void>((resolve, reject) => {
      let settled = false, unsubscribe = (): void => undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true; unsubscribe(); choice.signal.removeEventListener("abort", finish); resolve();
      };
      choice.signal.addEventListener("abort", finish, { once: true });
      try {
        unsubscribe = controller.subscribe(snapshot => {
          if (!valid() || snapshot.state !== "preparing" && snapshot.desktop?.phase !== "preparing") finish();
        });
        if (settled) unsubscribe();
        else if (!valid()) finish();
      } catch (error) {
        if (!settled) {
          settled = true; unsubscribe(); choice.signal.removeEventListener("abort", finish);
          reject(error instanceof Error ? error : new Error("consent_preparation_subscription_failed"));
        }
      }
    });
  }
  if (!valid()) return false;
  if (!empty(controller.snapshot) || controller.snapshot.sessionId !== sessionId) throw new Error("consent_preparation_not_empty");
  const check = (): void => {
    if (!valid() || !empty(controller.snapshot) || controller.snapshot.sessionId !== sessionId) throw new Error("consent_preparation_scope_changed");
  };
  if (choice.inputId) {
    if (!controller.selectAudioInput || !controller.snapshot.inputDevices?.some(row => row.id === choice.inputId)) {
      throw new Error("consent_preparation_input_unavailable");
    }
    if (controller.snapshot.selectedInputId !== choice.inputId) await controller.selectAudioInput(choice.inputId);
    check();
    if (controller.snapshot.selectedInputId !== choice.inputId) throw new Error("consent_preparation_input_unconfirmed");
  } else if (!controller.selectAudioInput && controller.selectMicrophoneInput) {
    await controller.selectMicrophoneInput(choice.microphone); check();
  }
  if (choice.desktopAudio) {
    if (!controller.selectDesktopAudio) throw new Error("consent_preparation_source_unavailable");
    if (controller.snapshot.desktop?.audioMode !== choice.desktopAudio) await controller.selectDesktopAudio(choice.desktopAudio);
    check();
    if (controller.snapshot.desktop?.audioMode !== choice.desktopAudio) throw new Error("consent_preparation_source_unconfirmed");
    if (choice.desktopAudio === "meeting") {
      if (!choice.meetingWindowId || !controller.selectMeetingWindow
        || !controller.snapshot.desktop?.meetingWindows?.windows.some(row => row.id === choice.meetingWindowId)) {
        throw new Error("consent_preparation_call_unavailable");
      }
      // Re-selecting an already accepted automatic call would make it explicit
      // in main, incorrectly changing the later ambiguity guard's provenance.
      if (controller.snapshot.desktop.meetingWindows?.selectedId !== choice.meetingWindowId) await controller.selectMeetingWindow(choice.meetingWindowId);
      check();
      if (controller.snapshot.desktop?.meetingWindows?.selectedId !== choice.meetingWindowId) throw new Error("consent_preparation_call_unconfirmed");
    }
  }
  return true;
}
