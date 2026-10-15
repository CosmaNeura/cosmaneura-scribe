import type { PluginListenerHandle } from "@capacitor/core";
import type { IOSRecordingOpenPlugin } from "./native-plugin";

/** A bounded native pending bit survives a link arriving before renderer startup.
 * Events contain no URL/identity and only request navigation to an existing run.
 */
export async function subscribeIOSRecordingOpen(source: IOSRecordingOpenPlugin,
  opened: () => void): Promise<PluginListenerHandle> {
  let closed = false;
  const consume = async (): Promise<void> => {
    const value = await source.takeRecordingOpenRequest();
    if (!closed && value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).sort().join() === "pending,version"
      && "version" in value && value.version === 1 && "pending" in value && value.pending === true) opened();
  };
  const listener = await source.addListener("recordingOpen", value => {
    if (value && typeof value === "object" && Object.keys(value).join() === "version"
      && "version" in value && value.version === 1) void consume().catch(() => undefined);
  });
  try { await consume(); }
  catch (error) { closed = true; await listener.remove(); throw error; }
  return { remove: async () => { closed = true; await listener.remove(); } };
}
