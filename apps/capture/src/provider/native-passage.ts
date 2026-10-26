import type { PlayPassage, NativePassageHandle } from "../../../review-ui/src/passage-playback";
import { isUuid } from "../../../review-ui/src/contracts";
import { QueueInvariantError } from "../queue/errors";
import type { ProviderNativePlugin } from "./native-plugin";

/** IDs and player metadata only. Native reauthorizes the segment's time range,
 * reads encrypted custody and keeps decrypted audio outside the WebView. */
export function nativePassagePlayer(plugin: ProviderNativePlugin,
  scope: { revision: string; workspaceId: string; bindingRef: string },
  signals: readonly AbortSignal[], current: () => void): PlayPassage {
  const bound = Object.freeze({ revision: scope.revision, workspaceId: scope.workspaceId, bindingRef: scope.bindingRef });
  return (sessionId, segmentId, signal) => {
    current();
    if (!isUuid(sessionId) || !isUuid(segmentId)) throw unavailable();
    const all = [...new Set([...signals, signal])];
    if (all.some(s => s.aborted)) throw unavailable();
    const requestId = crypto.randomUUID();
    let stopped = false, stopping: Promise<void> | null = null;
    const clear = (): void => { for (const s of all) s.removeEventListener("abort", cancel); };
    const stop = (): Promise<void> => {
      stopped = true; clear();
      return stopping ??= plugin.stopProviderPassage!({ requestId }).catch(error => { stopping = null; throw error; });
    };
    let rejectPending: (reason: unknown) => void = () => {};
    const cancel = (): void => { void stop().catch(() => undefined); rejectPending(unavailable()); };
    const checked = (value: unknown) => {
      current();
      if (stopped || all.some(s => s.aborted)) throw unavailable();
      return state(value);
    };
    const handle: NativePassageHandle = { stop, read: async () => {
      try {
        const value = checked(await plugin.readProviderPassage!({ requestId, revision: bound.revision }));
        if (!value) throw unavailable();
        if (!value.playing) await stop();
        return value;
      } catch (error) { void stop().catch(() => undefined); throw error; }
    } };
    return new Promise((resolve, reject) => {
      rejectPending = reject;
      for (const s of all) s.addEventListener("abort", cancel, { once: true });
      let pending: Promise<unknown>;
      try { pending = plugin.playProviderPassage!({ ...bound, requestId, sessionId, segmentId }); }
      catch (error) { clear(); reject(error instanceof Error ? error : unavailable()); return; }
      void pending.then(value => {
        try {
          const read = checked(value);
          if (!read) { clear(); resolve(null); return; }
          resolve({ native: handle });
        } catch (error) { void stop().catch(() => undefined); reject(error instanceof Error ? error : unavailable()); }
      }, error => { void stop().catch(() => undefined); reject(error instanceof Error ? error : unavailable()); });
    });
  };
}
function state(value: unknown): { playing: boolean; positionMs: number; durationMs: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const s = value as Record<string, unknown>;
  if (s.available === false && Object.keys(s).join() === "available") return null;
  if (Object.keys(s).sort().join() !== "available,durationMs,playing,positionMs" || s.available !== true
    || typeof s.playing !== "boolean" || typeof s.positionMs !== "number" || !Number.isSafeInteger(s.positionMs)
    || typeof s.durationMs !== "number" || !Number.isSafeInteger(s.durationMs)
    || s.positionMs < 0 || s.positionMs > s.durationMs || s.durationMs < 0 || s.durationMs > 30_000
    || s.playing && s.durationMs === 0) throw unavailable();
  return { playing: s.playing, positionMs: s.positionMs, durationMs: s.durationMs };
}
function unavailable(): QueueInvariantError { return new QueueInvariantError("provider_passage_unavailable"); }
