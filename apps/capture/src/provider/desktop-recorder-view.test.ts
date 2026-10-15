import { describe, expect, it } from "vitest";
import { connectDesktopRecorderView, parseDesktopRecorderRequest, parseDesktopRecorderState, type DesktopRecorderPort } from "./desktop-recorder-view";

const sessionId = "10000000-0000-4000-8000-000000000001", recorderId = "20000000-0000-4000-8000-000000000002";
const state = (revision: number, phase = "ready") => ({ recorderId, revision,
  snapshot: { sessionId, state: phase === "ready" ? "ready" : "recording", statusCode: "capture_ready",
    recordedChunks: revision, queuedChunks: 3, elapsedSeconds: 0, remainingBudgetSeconds: 30, remainingAuthoritySeconds: 30,
    transcriptionStatus: null, transcript: null, desktop: { phase, coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null } } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
describe("desktop recorder command view", () => {
  it("accepts only opaque named-input choices with one truthful current selection", () => {
    const inputId=crypto.randomUUID(), original=state(0);
    const withInputs=(inputDevices:unknown,selectedInputId:unknown)=>({...original,snapshot:{...original.snapshot,inputDevices,selectedInputId,reconnecting:false}});
    const devices=[{id:inputId,label:"USB microphone",kind:"external",current:true}];
    expect(parseDesktopRecorderState(withInputs(devices,inputId)).snapshot.selectedInputId).toBe(inputId);
    for (const invalid of [[{...devices[0],microphoneUID:"foreign-hardware"}], [{...devices[0],current:false}], [...devices,...devices]]) {
      expect(()=>parseDesktopRecorderState(withInputs(invalid,inputId))).toThrow();
    }
    const command={kind:"audio_input",requestId:crypto.randomUUID(),recorderId,inputId};
    expect(parseDesktopRecorderRequest(command)).toEqual(command);
    expect(()=>parseDesktopRecorderRequest({...command,microphoneUID:"foreign-hardware"})).toThrow();
    expect(()=>parseDesktopRecorderRequest({...command,kind:"start"})).toThrow();
  });
  it("accepts bounded inline labels and opaque IDs, never renderer process/window metadata", () => {
    const id = crypto.randomUUID(), original = state(0);
    const choices = { state: "ready", selectedId: id, windows: [{ id, title: "Zoom — Synthetic visit" }] };
    const snapshot = (meetingWindows: unknown) => ({ ...original, snapshot: { ...original.snapshot,
      desktop: { ...original.snapshot.desktop, meetingWindows } } });
    expect(parseDesktopRecorderState(snapshot(choices)).snapshot.desktop?.meetingWindows).toEqual(choices);
    for (const invalid of [{ ...choices, selectedId: crypto.randomUUID() }, { ...choices, windows: [...choices.windows, ...choices.windows] },
      { ...choices, windows: [{ id, title: "blocked\u0000" }] }, { ...choices, windows: [{ id, title: "Test", processID: 42 }] }]) {
      expect(() => parseDesktopRecorderState(snapshot(invalid))).toThrow();
    }
    const command = { kind: "meeting_window", requestId: crypto.randomUUID(), recorderId, windowId: id };
    expect(parseDesktopRecorderRequest(command)).toEqual(command);
    expect(() => parseDesktopRecorderRequest({ ...command, processID: 42 })).toThrow();
    expect(() => parseDesktopRecorderRequest({ ...command, kind: "start" })).toThrow();
  });
  it("accepts admitted preparation metadata without audio or new renderer authority", () => {
    const original = state(0);
    const preparing = { ...original, snapshot: { ...original.snapshot, state: "preparing", statusCode: "capture_preparing",
      desktop: { ...original.snapshot.desktop, phase: "preparing" } } };
    expect(parseDesktopRecorderState(preparing)).toEqual(preparing);
    expect(() => parseDesktopRecorderState({ ...preparing, credentials: "blocked" })).toThrow();
  });
  it("accepts existing snapshots and only bounded receipt-count progress", () => {
    const original = state(2);
    expect(parseDesktopRecorderState(original)).toEqual(original);
    const progress = (uploadProgress: unknown) => ({ ...original, snapshot: { ...original.snapshot, uploadProgress } });
    expect(parseDesktopRecorderState(progress({ total: 2, registered: 1 })).snapshot.uploadProgress)
      .toEqual({ total: 2, registered: 1 });
    for (const invalid of [null, { total: 3, registered: 1 }, { total: 1, registered: 2 },
      { total: 2, registered: -1 }, { total: 2, registered: 0.5 }, { total: 2, registered: 1, extra: "blocked" }]) {
      expect(() => parseDesktopRecorderState(progress(invalid))).toThrow();
    }
  });
  it("accepts only content-free bounded input activity", () => {
    const signal = (inputSignal: unknown) => {
      const original = state(0);
      return { ...original, snapshot: { ...original.snapshot, desktop: { ...original.snapshot.desktop, inputSignal } } };
    };
    expect(parseDesktopRecorderState(signal({ microphone: { level: 0.1, ageMs: 0 }, meetingAudio: null })).snapshot.desktop?.inputSignal)
      .toEqual({ microphone: { level: 0.1, ageMs: 0 }, meetingAudio: null });
    for (const value of [{ level: NaN, ageMs: 0 }, { level: 1.1, ageMs: 0 }, { level: 0.1, ageMs: -1 },
      { level: 0.1, ageMs: 0, device: "blocked" }]) {
      expect(() => parseDesktopRecorderState(signal({ microphone: value, meetingAudio: null }))).toThrow();
    }
    expect(() => parseDesktopRecorderState(signal({ microphone: null, meetingAudio: null, transcript: "blocked" }))).toThrow();
  });
  it("does not overwrite newer state with an older command response or accept another recorder", async () => {
    let observer: ((value: unknown) => void) | undefined;
    const delayed = deferred<unknown>(), commands: Parameters<DesktopRecorderPort["request"]>[0][] = [];
    const port: DesktopRecorderPort = { subscribe: listener => { observer = listener; return () => { observer = undefined; }; },
      request: command => {
        commands.push(command);
        if (command.kind === "start") return delayed.promise;
        return Promise.resolve({ requestId: command.requestId, ok: true, state: command.kind === "deactivate" ? null : state(0) });
      } };
    const view = await connectDesktopRecorderView(port, sessionId, new AbortController().signal);
    const starting = view.controller.startRecording(); observer!(state(2, "recording"));
    delayed.resolve({ requestId: commands.at(-1)!.requestId, ok: true, state: state(1, "starting") }); await starting;
    expect(view.controller.snapshot.recordedChunks).toBe(2); expect(view.controller.snapshot.desktop?.phase).toBe("recording");
    observer!({ ...state(3), recorderId: crypto.randomUUID() });
    await view.deactivate(); expect(() => view.controller.snapshot).toThrow();
    expect(commands.filter(command => command.kind === "deactivate")).toHaveLength(1);
    expect(commands.at(-1)!.recorderId).toBe(recorderId);
  });
  it("reveals the exact owned chooser without starting or replacing a recorder", async () => {
    const commands: Parameters<DesktopRecorderPort["request"]>[0][] = [];
    const port: DesktopRecorderPort = { subscribe: () => () => undefined, request: async command => {
      commands.push(command);
      return { requestId: command.requestId, ok: true, state: command.kind === "deactivate" ? null : state(0, "starting") };
    } };
    const view = await connectDesktopRecorderView(port, sessionId, new AbortController().signal);
    await view.controller.showWindowChooser!();
    expect(commands.map(command => command.kind)).toEqual(["read", "show_chooser"]);
    expect(commands[1]!.recorderId).toBe(recorderId);
    await view.deactivate();
    await expect(view.controller.showWindowChooser!()).rejects.toThrow();
    expect(commands).toHaveLength(3);
  });
  it("closes the exact late acquisition after cancellation and never exposes its snapshot", async () => {
    const read = deferred<unknown>(), abort = new AbortController(), commands: Parameters<DesktopRecorderPort["request"]>[0][] = [];
    const port: DesktopRecorderPort = { subscribe: () => () => undefined, request: command => {
      commands.push(command);
      return command.kind === "read" ? read.promise : Promise.resolve({ requestId: command.requestId, ok: true, state: null });
    } };
    const opening = connectDesktopRecorderView(port, sessionId, abort.signal), rejected = expect(opening).rejects.toThrow();
    abort.abort(); read.resolve({ requestId: commands[0]!.requestId, ok: true, state: state(0) }); await rejected;
    expect(commands.map(command => command.kind)).toEqual(["read", "deactivate"]);
    expect(commands[1]!.recorderId).toBe(recorderId);
  });
});
