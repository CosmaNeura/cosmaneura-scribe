import { exact } from "../../capture/src/provider/desktop-host-protocol";

/** Main/native pipe metadata only; it supplements existing capture authority. */
export interface NativeProcessFence {
  readonly epoch: string;
  readonly coordinatorDevice: string;
  readonly coordinatorInode: string;
  readonly captureDevice: string;
  readonly captureInode: string;
}
export function parseNativeProcessFence(raw: unknown): NativeProcessFence {
  const value = exact(raw, ["epoch", "coordinatorDevice", "coordinatorInode", "captureDevice", "captureInode"]);
  if (typeof value.epoch !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.epoch)) throw unavailable();
  const number = (key: string, signed: boolean): string => {
    const text = value[key];
    if (typeof text !== "string" || text.length > 20 || !/^-?(?:0|[1-9][0-9]*)$/u.test(text)) throw unavailable();
    const integer = BigInt(text);
    if (String(integer) !== text || integer < (signed ? -(2n ** 63n) : 1n)
      || integer > (signed ? 2n ** 63n - 1n : 2n ** 64n - 1n)) throw unavailable();
    return text;
  };
  return Object.freeze({ epoch: value.epoch, coordinatorDevice: number("coordinatorDevice", true),
    coordinatorInode: number("coordinatorInode", false), captureDevice: number("captureDevice", true),
    captureInode: number("captureInode", false) });
}
function unavailable(): Error { return new Error("native_process_fence_unavailable"); }
