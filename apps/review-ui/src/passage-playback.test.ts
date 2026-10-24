import { afterEach, expect, it, vi } from "vitest";
import { bindTranscriptPlayback, type TranscriptPlaybackOptions } from "./passage-playback";
import { parseCreatorReview } from "./creator-review-api";

// Actual binding, promises and cleanup execute on a small DOM event fixture.
// Audio play/load are spies: these tests neither open a device nor decode sound.
class Surface extends EventTarget {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: Surface[] = [];
  parentElement: Surface | null = null;
  connectedRoot = false;
  disabled = false;
  hidden = false;
  type = "";
  private text = "";
  constructor(readonly tag = "div") { super(); }
  get isConnected(): boolean { return this.connectedRoot || this.parentElement?.isConnected === true; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  matches(selector: string): boolean {
    if (selector === 'button[data-review-action="play-passage"]') return this.tag === "button" && this.dataset.reviewAction === "play-passage";
    if (selector === "[data-transcript-segment]") return this.dataset.transcriptSegment !== undefined;
    if (selector === "[data-playback-result]") return this.dataset.playbackResult !== undefined;
    return selector === this.tag;
  }
  querySelectorAll(selector: string): Surface[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): Surface | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): Surface | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  contains(element: unknown): boolean { return element === this || this.children.some(child => child.contains(element)); }
  append(...children: Surface[]): void { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  remove(): void {
    if (this.parentElement) { const index = this.parentElement.children.indexOf(this); if (index >= 0) this.parentElement.children.splice(index, 1); }
    this.parentElement = null;
  }
  replaceChildren(...children: Surface[]): void { for (const child of [...this.children]) child.remove(); this.text = ""; this.append(...children); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
}
class Details extends Surface { open = true; constructor() { super("details"); } }
class Audio extends Surface {
  controls = false;
  preload = "";
  src = "";
  readonly play = vi.fn(async () => {});
  readonly pause = vi.fn();
  readonly load = vi.fn();
  constructor() { super("audio"); }
  override removeAttribute(name: string): void { super.removeAttribute(name); if (name === "src") this.src = ""; }
}
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const syntheticConsent = { recordId: id(5), syntheticOnly: true, allPartiesConsented: true };
const ready = () => parseCreatorReview({ schema_version: "1.0", session_id: id(1), status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [2, 3].map((n, i) => ({ source_segment_id: id(n), source_segment_version: 1,
    source_locale: "en-US", speaker_role: "unknown", content: "Invented passage.", start_ms: i * 1000, end_ms: i * 1000 + 1000 })) },
  working: { source_transcript_version: 1, working_transcript_id: id(4), working_transcript_version: 1,
    note_ready: true, blockers: [], segments: [2, 3].map(n => ({ source_segment_id: id(n), source_segment_version: 1,
      resolution: "english_source", content: "Invented passage." })) },
  review_queue: { schema_version: "1.0", session_id: id(1), source_transcript_version: 1,
    working_transcript_id: id(4), working_transcript_version: 1, status: "complete", items: [] },
}, id(1));
const wav = (): { wavBase64: string } => {
  // A one-sample PCM16 mono 16kHz RIFF fixture, not captured speech.
  if (!syntheticConsent.syntheticOnly || !syntheticConsent.allPartiesConsented) throw new Error("Fixture consent missing");
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer);
  for (const [at, text] of [[0, "RIFF"], [8, "WAVEfmt "], [36, "data"]] as const) bytes.set(new TextEncoder().encode(text), at);
  view.setUint32(4, 38, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 2, true);
  return { wavBase64: btoa(String.fromCharCode(...bytes)) };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
};
const selector = 'button[data-review-action="play-passage"]';
type PassagePlayer = NonNullable<TranscriptPlaybackOptions["playPassage"]>;
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(playPassage?: TranscriptPlaybackOptions["playPassage"], authorized = true, rejectAutoplay = false) {
  const root = new Surface(), details = new Details(), rows = [new Surface("li"), new Surface("li"), new Surface("li")];
  root.connectedRoot = true; root.append(details); details.append(...rows);
  rows.forEach((row, index) => { row.dataset.transcriptSegment = id(index + 2); });
  const editor = Object.assign(new Surface("textarea"), { value: "Unsaved invented text", defaultValue: "Saved invented text", selectionStart: 3, selectionEnd: 8, scrollTop: 19, readOnly: true });
  root.append(editor);
  const abort = new AbortController(), audios: Audio[] = [], urls: Blob[] = [];
  const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { urls.push(blob as Blob); return `blob:synthetic-${urls.length}`; });
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("Element", Surface); vi.stubGlobal("HTMLDetailsElement", Details);
  vi.stubGlobal("document", { createElement: (tag: string) => {
    if (tag === "audio") {
      const audio = new Audio();
      if (rejectAutoplay) audio.play.mockRejectedValue(new DOMException("Synthetic autoplay denied", "NotAllowedError"));
      audios.push(audio); return audio;
    }
    return new Surface(tag);
  } });
  let view: ReturnType<typeof ready> | null = authorized ? ready() : null;
  const binding = bindTranscriptPlayback(root as unknown as HTMLElement, { current: () => view,
    ...(playPassage ? { playPassage } : {}), signal: abort.signal });
  disposers.push(binding.dispose); binding.render();
  const buttons = (): Surface[] => root.querySelectorAll(selector);
  const dispatch = (type: string, target: Surface): void => { const event = new Event(type); Object.defineProperty(event, "target", { value: target }); root.dispatchEvent(event); };
  return { root, details, rows, editor, abort, audios, urls, createUrl, revokeUrl, binding, buttons, dispatch,
    current: () => view, setView: (next: typeof view) => { view = next; },
    click: (index = 0) => dispatch("click", buttons()[index]!) };
}

it("offers exactly one button per authorized source row, without replacing editors or adding controls when capability/view is absent", () => {
  const absent = fixture(); expect(absent.buttons()).toHaveLength(0);
  const denied = fixture(vi.fn(async () => null), false); expect(denied.buttons()).toHaveLength(0);
  const f = fixture(vi.fn(async () => null)); const { editor } = f;
  f.binding.render();
  expect(f.buttons()).toHaveLength(2); expect(f.rows[2]!.querySelector(selector)).toBeNull();
  expect(f.buttons().map(button => button.textContent)).toEqual(["Listen to passage", "Listen to passage"]);
  expect(f.root.querySelector("textarea")).toBe(editor);
  expect([editor.value, editor.defaultValue, editor.selectionStart, editor.selectionEnd, editor.scrollTop, editor.readOnly])
    .toEqual(["Unsaved invented text", "Saved invented text", 3, 8, 19, true]);
});

it("plays only the matching current session and segment, with a single bounded player", async () => {
  const play = vi.fn<PassagePlayer>(async () => wav()), f = fixture(play);
  f.click(); await vi.waitFor(() => expect(f.audios).toHaveLength(1));
  expect(play.mock.calls[0]).toEqual([id(1), id(2), expect.any(AbortSignal)]);
  expect(f.audios[0]!.controls).toBe(true); expect(f.audios[0]!.play).toHaveBeenCalledOnce();
  expect(f.audios[0]!.attributes.get("aria-label")).toBe("Recorded passage, up to 30 seconds");
  const firstSignal = play.mock.calls[0]![2];
  f.click(1); await vi.waitFor(() => expect(f.audios).toHaveLength(2));
  expect(firstSignal.aborted).toBe(true); expect(f.root.querySelectorAll("audio")).toHaveLength(1);
  expect(f.audios[0]!.pause).toHaveBeenCalledOnce(); expect(f.audios[0]!.load).toHaveBeenCalledOnce(); expect(f.audios[0]!.src).toBe("");
  expect(f.revokeUrl).toHaveBeenCalledWith("blob:synthetic-1");
  expect(f.root.querySelector("textarea")).toBe(f.editor); expect(f.editor.value).toBe("Unsaved invented text");
});

it("ignores tampered segment buttons, duplicate clicks while loading, and disconnected controls", async () => {
  const pending = deferred<null>(), play = vi.fn(() => pending.promise), f = fixture(play);
  const button = f.buttons()[0]!;
  button.dataset.segment = id(99); f.click(); expect(play).not.toHaveBeenCalled();
  button.dataset.segment = id(2); f.click(); f.click(); expect(play).toHaveBeenCalledOnce();
  f.binding.stop(); button.remove(); f.dispatch("click", button); expect(play).toHaveBeenCalledOnce();
  pending.resolve(null); await vi.waitFor(() => expect(f.root.querySelectorAll("audio")).toHaveLength(0));
});

it.each(["stop", "dispose", "abort", "details", "source"] as const)("%s cancels and releases an active player", async action => {
  const play = vi.fn<PassagePlayer>(async () => wav()), f = fixture(play);
  f.click(); await vi.waitFor(() => expect(f.audios).toHaveLength(1));
  const signal = play.mock.calls[0]![2];
  if (action === "stop") f.binding.stop();
  else if (action === "dispose") f.binding.dispose();
  else if (action === "abort") f.abort.abort();
  else if (action === "details") { f.details.open = false; f.dispatch("toggle", f.details); }
  else { f.setView(ready()); f.binding.render(); }
  expect(signal.aborted).toBe(true); expect(f.audios[0]!.pause).toHaveBeenCalledOnce(); expect(f.audios[0]!.load).toHaveBeenCalledOnce();
  expect(f.revokeUrl).toHaveBeenCalledWith("blob:synthetic-1"); expect(f.root.querySelectorAll("audio")).toHaveLength(0);
  f.audios[0]!.dispatchEvent(new Event("error")); expect(f.root.querySelector("[data-playback-result]")).toBeNull();
  expect(f.editor.value).toBe("Unsaved invented text");
});

it.each(["stop", "dispose", "abort", "source", "detached"] as const)("late results after %s cannot create or play audio", async action => {
  const pending = deferred<{ wavBase64: string }>(), play = vi.fn(() => pending.promise), f = fixture(play);
  f.click();
  if (action === "stop") f.binding.stop();
  else if (action === "dispose") f.binding.dispose();
  else if (action === "abort") f.abort.abort();
  else if (action === "source") f.setView(ready());
  else f.rows[0]!.remove();
  pending.resolve(wav()); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.createUrl).not.toHaveBeenCalled(); expect(f.audios).toHaveLength(0);
});

it("keeps a newer pending passage when an older request resolves after cancellation", async () => {
  const first = deferred<{ wavBase64: string }>(), second = deferred<{ wavBase64: string }>();
  const play = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const f = fixture(play); f.click(); f.click(1);
  first.resolve(wav()); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.createUrl).not.toHaveBeenCalled(); expect(f.buttons()[1]!.disabled).toBe(true);
  second.resolve(wav()); await vi.waitFor(() => expect(f.audios).toHaveLength(1));
  expect(f.buttons()[1]!.disabled).toBe(false); expect(f.rows[1]!.querySelectorAll("audio")).toHaveLength(1);
});

it("keeps the same passage disabled when a canceled read finishes after hide and retry", async () => {
  const first = deferred<{ wavBase64: string }>(), second = deferred<{ wavBase64: string }>();
  const play = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const f = fixture(play), button = f.buttons()[0]!;
  f.click(); f.binding.stop(); // Hide keeps the transcript DOM mounted.
  expect(button.disabled).toBe(false);
  f.click(); expect(f.buttons()[0]).toBe(button); expect(button.disabled).toBe(true);
  first.resolve(wav()); await new Promise(resolve => setTimeout(resolve, 0));
  expect(button.disabled).toBe(true); expect(f.createUrl).not.toHaveBeenCalled();
  f.click(); expect(play).toHaveBeenCalledTimes(2);
  second.resolve(wav()); await vi.waitFor(() => expect(f.audios).toHaveLength(1));
  expect(button.disabled).toBe(false); expect(f.audios[0]!.play).toHaveBeenCalledOnce();
});

it.each(["null", "rejected", "invalid-base64", "oversize"] as const)("reports %s without creating an audio player", async kind => {
  const play = vi.fn(async () => {
    if (kind === "rejected") throw new Error("Invented I/O failure");
    return kind === "null" ? null : { wavBase64: kind === "oversize" ? "A".repeat(1_300_004) : "%%%" };
  });
  const f = fixture(play); f.click();
  await vi.waitFor(() => expect(f.rows[0]!.textContent).toContain(kind === "null" ? "unavailable for this passage" : "Audio could not open"));
  expect(f.createUrl).not.toHaveBeenCalled(); expect(f.buttons()[0]!.disabled).toBe(false);
});

it("reports decoder failure for invalid WAV media and releases its object URL", async () => {
  const f = fixture(vi.fn(async () => ({ wavBase64: btoa("Not a WAV") })));
  f.click(); await vi.waitFor(() => expect(f.audios).toHaveLength(1));
  f.audios[0]!.dispatchEvent(new Event("error"));
  expect(f.rows[0]!.textContent).toContain("Audio could not open"); expect(f.root.querySelectorAll("audio")).toHaveLength(0);
  expect(f.revokeUrl).toHaveBeenCalledWith("blob:synthetic-1"); expect(f.audios[0]!.src).toBe("");
});

it("retains manual controls when autoplay is denied without claiming playback succeeded", async () => {
  const f = fixture(vi.fn(async () => wav()), true, true);
  f.click(); await vi.waitFor(() => expect(f.audios).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.audios[0]!.controls).toBe(true); expect(f.audios[0]!.play).toHaveBeenCalledOnce();
  expect(f.root.querySelectorAll("audio")).toHaveLength(1); expect(f.buttons()[0]!.disabled).toBe(false);
  expect(f.rows[0]!.textContent).not.toMatch(/playing|played|Audio could not open/u);
  expect(f.revokeUrl).not.toHaveBeenCalled();
});
