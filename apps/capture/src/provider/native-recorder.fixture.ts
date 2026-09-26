import type { NativeRecordingState, NativeRecordingPort } from "./native-recorder";

// Synthetic metadata only; never starts an OS audio source or contacts Core.
export const syntheticSession = "10000000-0000-4000-8000-000000000001";
export function recordingFixture(sessionId = syntheticSession) {
  let state: NativeRecordingState = { version: 1, revision: 1, recorderId: crypto.randomUUID(), sessionId,
    phase: "ready", failure: null, busy: false, recordedChunks: 0, recordedPlaintextBytes: 0,
    maximumPlaintextBytes: 402_653_184, input: "built_in", completion: null, signal: { version: 2, signal: null } };
  const commands: Parameters<NativeRecordingPort["command"]>[0][] = [];
  const response = (requestId: string, ok = true) => ({ requestId, ok, recording: structuredClone(state) });
  const port: NativeRecordingPort = { open: (_session, id) => Promise.resolve(response(id)), command: request => {
    commands.push(request);
    if (request.kind === "close") return Promise.resolve({ requestId: request.requestId, ok: true, recording: null });
    state = { ...state, revision: state.revision + 1,
      phase: request.kind === "start" ? "recording" : request.kind === "pause" ? "paused" : state.phase,
      input: request.input ?? state.input };
    return Promise.resolve(response(request.requestId));
  } };
  return { port, commands, response, get state() { return state; },
    set: (update: Partial<NativeRecordingState>) => { state = { ...state, ...update, revision: state.revision + 1 }; } };
}
