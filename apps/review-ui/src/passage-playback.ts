import type { CreatorReviewView } from "./creator-review-api";

export interface NativePassageHandle {
  read(): Promise<{ playing: boolean; positionMs: number; durationMs: number }>;
  stop(): Promise<void>;
}
export type PassagePlayback = { wavBase64: string } | { native: NativePassageHandle };
export type PlayPassage = (sessionId: string, segmentId: string, signal: AbortSignal) => Promise<PassagePlayback | null>;

export interface TranscriptPlaybackOptions {
  /** Returns only this mounted surface's current, authorized transcript. */
  readonly current: () => CreatorReviewView | null;
  readonly playPassage?: PlayPassage;
  readonly signal?: AbortSignal;
}

/** Adds playback to existing transcript rows without replacing editor or transcript DOM. */
export function bindTranscriptPlayback(root: HTMLElement, options: TranscriptPlaybackOptions): {
  render: () => void; stop: () => void; dispose: () => void;
} {
  let disposed = false;
  let playbackAbort: AbortController | null = null, playbackUrl: string | null = null;
  let playbackAudio: HTMLAudioElement | null = null;
  let nativeAudio: NativePassageHandle | null = null, nativeTimer: ReturnType<typeof setTimeout> | null = null;
  let playbackResult: HTMLDivElement | null = null, pendingButton: HTMLButtonElement | null = null;
  const selector = 'button[data-review-action="play-passage"]';
  const releaseAudio = (): void => {
    if (nativeTimer !== null) clearTimeout(nativeTimer); nativeTimer = null;
    const native = nativeAudio; nativeAudio = null;
    if (native) void native.stop().catch(() => undefined);
    if (playbackAudio) { playbackAudio.pause(); playbackAudio.removeAttribute("src"); playbackAudio.load(); playbackAudio = null; }
    if (playbackUrl) URL.revokeObjectURL(playbackUrl); playbackUrl = null;
  };
  const stop = (): void => {
    playbackAbort?.abort(); playbackAbort = null;
    releaseAudio();
    if (pendingButton?.isConnected) pendingButton.disabled = false; pendingButton = null;
    playbackResult?.remove(); playbackResult = null;
  };
  const render = (): void => {
    stop();
    if (!options.playPassage) return;
    for (const button of root.querySelectorAll(selector)) button.remove();
    const view = options.current();
    if (disposed || options.signal?.aborted || !view?.source) return;
    const segments = new Set(view.source.segments.map(segment => segment.source_segment_id));
    for (const row of root.querySelectorAll<HTMLElement>("[data-transcript-segment]")) {
      const id = row.dataset.transcriptSegment;
      if (!id || !segments.has(id)) continue;
      const button = document.createElement("button"); button.type = "button";
      button.dataset.reviewAction = "play-passage"; button.dataset.segment = id;
      button.textContent = "Listen to passage"; row.append(button);
    }
  };
  const play = (event: Event): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(selector) : null;
    const view = options.current();
    if (disposed || options.signal?.aborted || !button || button.disabled || !root.contains(button)
      || !options.playPassage || !view?.source || !button.dataset.segment) return;
    const row = button.closest<HTMLElement>("[data-transcript-segment]");
    const id = button.dataset.segment;
    if (!row || row.dataset.transcriptSegment !== id || !view.source.segments.some(segment => segment.source_segment_id === id)) return;
    stop();
    const controller = new AbortController(); playbackAbort = controller;
    const result = document.createElement("div"); playbackResult = result;
    result.dataset.playbackResult = ""; result.setAttribute("role", "status");
    result.textContent = "Opening saved audio…"; row.append(result); button.disabled = true; pendingButton = button;
    const current = (): boolean => !disposed && !controller.signal.aborted && !options.signal?.aborted
      && options.current() === view && playbackResult === result && result.isConnected;
    const failed = (): void => {
      if (!current()) return;
      releaseAudio(); result.textContent = "Audio could not open. Check your connection and try again.";
    };
    void options.playPassage(view.session_id, id, controller.signal).then(value => {
      if (!current()) { if (value && "native" in value) void value.native.stop().catch(() => undefined); return; }
      if (!value) { result.textContent = "Audio playback is unavailable for this passage on this device. The transcript is retained."; return; }
      if ("native" in value) {
        const handle = value.native; nativeAudio = handle;
        const label = document.createElement("span"), stopButton = document.createElement("button");
        stopButton.type = "button"; stopButton.textContent = "Stop passage";
        stopButton.addEventListener("click", () => {
          if (nativeTimer !== null) clearTimeout(nativeTimer); nativeTimer = null;
          stopButton.disabled = true;
          void handle.stop().then(() => {
            if (nativeAudio === handle) nativeAudio = null;
            if (current()) result.textContent = "Playback stopped.";
          }).catch(() => { if (current()) { label.textContent = "Audio could not stop. Try again."; stopButton.disabled = false; } });
        });
        result.replaceChildren(label, stopButton);
        const poll = async (): Promise<void> => {
          if (!current() || nativeAudio !== handle) return;
          try {
            const state = await handle.read();
            if (!current() || nativeAudio !== handle) return;
            if (!state.playing) { nativeAudio = null; await handle.stop(); result.textContent = "Playback finished."; return; }
            label.textContent = `Playing passage: ${Math.floor(state.positionMs / 1000)} of ${Math.ceil(state.durationMs / 1000)} seconds. `;
            nativeTimer = setTimeout(() => { void poll(); }, 250);
          } catch { failed(); }
        };
        void poll(); return;
      }
      if (value.wavBase64.length > 1_300_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.wavBase64)) throw new Error("Invalid passage audio");
      const bytes = Uint8Array.from(atob(value.wavBase64), char => char.charCodeAt(0));
      try { playbackUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); } finally { bytes.fill(0); }
      const audio = document.createElement("audio"); audio.controls = true; audio.preload = "none";
      playbackAudio = audio; audio.src = playbackUrl; audio.setAttribute("aria-label", "Recorded passage, up to 30 seconds"); result.replaceChildren(audio);
      audio.addEventListener("error", failed, { once: true });
      void audio.play().catch(() => undefined);
    }).catch(failed).finally(() => {
      if (playbackAbort === controller && playbackResult === result && pendingButton === button) {
        if (button.isConnected) button.disabled = false;
        pendingButton = null;
      }
    });
  };
  const toggle = (event: Event): void => {
    const details = event.target;
    if (details instanceof HTMLDetailsElement && !details.open && playbackResult && details.contains(playbackResult)) stop();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; stop(); root.removeEventListener("click", play); root.removeEventListener("toggle", toggle, true);
    options.signal?.removeEventListener("abort", dispose);
  };
  root.addEventListener("click", play); root.addEventListener("toggle", toggle, true);
  options.signal?.addEventListener("abort", dispose, { once: true });
  if (options.signal?.aborted) dispose();
  return { render, stop, dispose };
}
