// Test-only input from the retained real coordinator in the synthetic runner.
// Never imported by the product host or used to construct an invented fence.
import { parseNativeProcessFence, type NativeProcessFence } from "./native-process-fence.js";

export function nativePipeFixtureFence(): NativeProcessFence {
  const raw = process.env.SCRIBE_DESKTOP_PIPE_FENCE;
  if (!raw) throw new Error("compiled fixture coordinator required");
  return parseNativeProcessFence(JSON.parse(raw) as unknown);
}
