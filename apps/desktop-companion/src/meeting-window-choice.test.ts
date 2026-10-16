import { expect, it, vi } from "vitest";
import { CAPTURE_OPERATION_TIMEOUT_MS } from "./config.js";
import { isRecognizedCallWindow, readMeetingWindows, recommendedCallWindow, sameCallWindow } from "./meeting-window-choice.js";
import type { NativeMeetingWindow } from "./native-provider-presentation.js";

const meet: NativeMeetingWindow = { application: "com.google.Chrome", processID: 10, windowID: 20, title: "Chrome — Meet - abc-defg-hij" };
const zoom: NativeMeetingWindow = { application: "us.zoom.xos", processID: 11, windowID: 21, title: "Zoom — Zoom Meeting" };
const choice = (value: NativeMeetingWindow, id = crypto.randomUUID()) => ({ id, value });
it.each(["Meet - abc-defg-hij", "Meet – abc-defg-hij", "Meet — abc-defg-hij", "Chrome — Meet - abc-defg-hij - Google Chrome",
  "Chrome — Meet — abc-defg-hij — Google Chrome"])("recognizes canonical visible Meet title %s", title => {
  expect(isRecognizedCallWindow({ ...meet, title })).toBe(true);
});
it.each(["Google Meet", "Meet", "Meet - Home", "Meet - abc-defg-hij - Document", "Meet - abc-defg-hij - Other Browser",
  "Chrome – Meet - abc-defg-hij", "Document — Meet - abc-defg-hij", "Meet - abcd-efg-hij", "https://meet.google.com/abc-defg-hij"])("does not infer a call from %s", title => {
  expect(isRecognizedCallWindow({ ...meet, title })).toBe(false);
});
it("requires the typed application and only Zoom's meeting/webinar titles", () => {
  expect(isRecognizedCallWindow(zoom)).toBe(true);
  expect(isRecognizedCallWindow({ ...zoom, title: "Zoom Webinar" })).toBe(true);
  for (const title of ["Zoom", "Zoom Workplace", "Zoom — Home", "Zoom Meeting settings", meet.title]) {
    expect(isRecognizedCallWindow({ ...zoom, title })).toBe(false);
  }
  expect(isRecognizedCallWindow({ ...meet, title: zoom.title })).toBe(false);
});
it("selects the sole recognized call among thirty other visible windows, never guesses between calls", () => {
  const other = Array.from({ length: 30 }, (_, n) => choice({ ...meet, windowID: n + 30, title: `Invented document ${n}` }));
  const selected = choice(meet);
  expect(recommendedCallWindow([...other, selected])).toBe(selected);
  expect(recommendedCallWindow([...other, choice(zoom)])?.value).toEqual(zoom);
  expect(recommendedCallWindow([...other, selected, choice(zoom)])).toBeNull();
  expect(recommendedCallWindow(other)).toBeNull();
});
it("requires the current title as well as the full native identity", () => {
  expect(sameCallWindow(meet, { ...meet })).toBe(true);
  for (const changed of [{ ...meet, title: "Invented document" }, { ...meet, windowID: 22 }, { ...meet, processID: 12 },
    { ...meet, application: "us.zoom.xos" as const }]) expect(sameCallWindow(meet, changed)).toBe(false);
});
it("validates the closed bounded catalogue without starting native audio", async () => {
  const list = vi.fn(async () => [meet]);
  expect(await readMeetingWindows(list, new AbortController().signal)).toEqual([meet]);
  await expect(readMeetingWindows(async () => [meet, meet], new AbortController().signal)).rejects.toThrow();
  await expect(readMeetingWindows(async () => Array.from({ length: 65 }, (_, n) => ({ ...meet, windowID: n + 1 })), new AbortController().signal)).rejects.toThrow();
});
it("cancels an outstanding catalogue and discards its late result", async () => {
  let resolve!: (values: readonly NativeMeetingWindow[]) => void;
  const pending = new Promise<readonly NativeMeetingWindow[]>(done => { resolve = done; });
  const abort = new AbortController(), list = vi.fn((signal: AbortSignal) => { expect(signal.aborted).toBe(false); return pending; });
  const result = readMeetingWindows(list, abort.signal), rejected = expect(result).rejects.toThrow();
  await Promise.resolve(); abort.abort(); await rejected;
  expect(list.mock.calls[0]![0].aborted).toBe(true); resolve([meet]); await Promise.resolve();
});
it("bounds a hung metadata read and aborts its native request", async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const result = readMeetingWindows(async next => { signal = next; return new Promise(() => undefined); }, new AbortController().signal);
    const rejected = expect(result).rejects.toThrow(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(CAPTURE_OPERATION_TIMEOUT_MS); await rejected;
    expect(signal?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});
