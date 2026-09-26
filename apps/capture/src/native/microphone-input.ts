/** Shared choices for preparation and the existing paused-recorder control. */
export const microphoneInputs = [
  { value: "built_in", label: "iPhone microphone", help: "Use the iPhone microphone for a conversation in the room." },
  { value: "bluetooth", label: "Bluetooth microphone (AirPods or headset)", help: "Connect your AirPods or headset before recording. Check that both voices are audible." },
  { value: "external", label: "USB or wired microphone", help: "Connect your USB or wired microphone before recording. Check that both voices are audible." },
] as const;
export type MicrophoneInput = typeof microphoneInputs[number]["value"];
export function isMicrophoneInput(value: unknown): value is MicrophoneInput {
  return microphoneInputs.some(input => input.value === value);
}
