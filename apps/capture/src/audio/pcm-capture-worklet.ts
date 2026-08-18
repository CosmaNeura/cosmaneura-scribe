import {
  PCM_CAPTURE_WORKLET_NAME,
} from "./worklet-protocol";
import { encodeWorkletPacket } from "./worklet-packet";

declare abstract class AudioWorkletProcessor {
  protected readonly port: MessagePort;
  public abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  #sequence = 0;

  public process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    const packet = encodeWorkletPacket(channels, this.#sequence);
    this.#sequence += 1;
    this.port.postMessage(packet.message, packet.transfer);
    return true;
  }
}

registerProcessor(PCM_CAPTURE_WORKLET_NAME, PcmCaptureProcessor);
