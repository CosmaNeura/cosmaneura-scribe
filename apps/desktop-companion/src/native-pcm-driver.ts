/** Trusted native-to-main boundary for ScribeDesktopAudio. Never expose this
 * interface, raw PCM, selected-window authority or credentials to the renderer.
 * The driver is owned by the existing fresh-authority/lease/indicator controller.
 */
export interface DesktopPCMStart {
  readonly hostTimeNanoseconds: string;
  readonly microphonePrerollNanoseconds: string;
  readonly systemPrerollNanoseconds: string;
}
export interface DesktopPCMCompletion {
  readonly start: DesktopPCMStart;
  readonly endHostTimeNanoseconds: string;
  readonly outputFrames: number;
  readonly microphoneTailNanoseconds: string;
  readonly systemTailNanoseconds: string;
}
export type DesktopPCMCoverage =
  | { readonly phase: "started"; readonly value: DesktopPCMStart }
  | { readonly phase: "stopped"; readonly value: DesktopPCMCompletion };
export interface DesktopPCMPacket {
  readonly firstFrame: number;
  /** One complete owned buffer, <=4096 frames of mono signed PCM16 little-endian. */
  readonly pcmBytes: Uint8Array<ArrayBuffer>;
}
export type DesktopPCMFailure = "permission_required" | "device_changed" | "session_locked"
  | "clock_discontinuity" | "overflow" | "failed";
export interface DesktopPCMDriverSession {
  /** Both native sources are running and their common recording start is known.
   * Native retention before activate is bounded; no packet can arrive yet.
   */
  readonly ready: Promise<DesktopPCMStart>;
  activate(): void;
  /** Drain stops the OS sources, delivers all accepted packets with awaited
   * acknowledgements, then returns mixer completion. Discard returns null.
   * Discard can upgrade a pending drain. Failure retains this exact handle;
   * a successful result confirms no source or subsequent callback remains.
   */
  stop(options: { readonly mode: "drain" | "discard" }): Promise<DesktopPCMCompletion | null>;
}
export interface DesktopPCMDriver {
  /** Permission/unlocked-session read only. Focus loss is not desktop lock. */
  getAvailability(): Promise<boolean>;
  /** The owner already holds fresh capability/consent, selection and indicator.
   * Return the session synchronously; startup cancellation must not await ready.
   * Configuration is derived from the existing Core reservation/capture window.
   */
  start(configuration: { readonly maximumOutputFrames: number; readonly sampleRateHz: 16_000 }, sink: {
    readonly onPcmPacket: (packet: DesktopPCMPacket) => Promise<void>;
    readonly onFailure: (code: DesktopPCMFailure) => void;
  }): DesktopPCMDriverSession;
}
