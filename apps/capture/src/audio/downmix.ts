import { AudioCaptureError } from "./errors";

/** Deterministically averages an AudioWorklet render quantum into one mono channel. */
export function downmixToMono(
  channels: readonly Float32Array[],
): Float32Array<ArrayBuffer> {
  const firstChannel = channels[0];
  if (firstChannel === undefined || firstChannel.length === 0) {
    throw new AudioCaptureError("audio_capture_invalid_pcm");
  }
  const frameCount = firstChannel.length;
  if (channels.some((channel) => channel.length !== frameCount)) {
    throw new AudioCaptureError("audio_capture_invalid_pcm");
  }

  const mono = new Float32Array(frameCount);
  for (const channel of channels) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sample = channel[frame];
      if (sample === undefined || !Number.isFinite(sample)) {
        throw new AudioCaptureError("audio_capture_invalid_pcm");
      }
      mono[frame] = (mono[frame] ?? 0) + sample;
    }
  }
  const scale = 1 / channels.length;
  for (let frame = 0; frame < frameCount; frame += 1) {
    mono[frame] = (mono[frame] ?? 0) * scale;
  }
  return mono;
}
