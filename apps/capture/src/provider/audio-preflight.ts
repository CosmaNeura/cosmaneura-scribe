export interface AudioInputDevice {
  readonly id: string;
  readonly label: string;
  readonly kind: "built_in" | "bluetooth" | "external" | "unknown";
  readonly current: boolean;
}
export interface AudioPreflightSnapshot {
  readonly status: "checking" | "ready" | "permission_required" | "unavailable";
  readonly inputDevices: readonly AudioInputDevice[];
  readonly selectedInputId: string | null;
  readonly microphone: { readonly level: number; readonly ageMs: number } | null;
  readonly desktopAudio?: "microphone" | "meeting";
  readonly meetingWindows?: { readonly state: "ready" | "unavailable"; readonly windows: readonly { readonly id: string; readonly title: string }[]; readonly selectedId: string | null };
}
/** Advisory native meter. It emits no PCM and owns no recording or consent grant. */
export interface ProviderAudioPreflight {
  getSnapshot(): AudioPreflightSnapshot;
  subscribe(listener: (snapshot: AudioPreflightSnapshot) => void): () => void;
  selectMicrophone(id: string): Promise<void>;
  selectDesktopAudio?(mode: "microphone" | "meeting"): Promise<void>;
  refreshMeetingWindows?(): Promise<void>;
  selectMeetingWindow?(id: string): Promise<void>;
  close(): Promise<void>;
}

export function inputVerdict(signal: AudioPreflightSnapshot["microphone"], paused = false): string {
  if (paused) return "Not listening";
  if (!signal || !Number.isFinite(signal.level) || signal.level < 0 || signal.level > 1 || signal.ageMs < 0 || signal.ageMs > 1500) return "Checking microphone…";
  return signal.level > .015 ? "Hearing you ✓" : "Speak to check the microphone";
}
