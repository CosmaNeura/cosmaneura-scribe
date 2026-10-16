import { expect, it, vi } from "vitest";
import { DesktopAudioPreflight } from "./desktop-audio-preflight.js";
import type { NativeMicrophoneInputService } from "./native-microphone-inputs.js";
import { NativeScreenAccessRequired, type NativeMeetingWindow } from "./native-provider-presentation.js";

function inputs(): NativeMicrophoneInputService {
  return {getSnapshot:()=>({status:"ready",inputDevices:[],selectedInputId:null,microphone:null}),
    subscribe:()=>()=>undefined,startCheck:async()=>undefined,selectMicrophone:async()=>undefined,close:async()=>undefined} as unknown as NativeMicrophoneInputService;
}
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
it("shares opaque choices only for the same current native call identity", async () => {
  let windows: NativeMeetingWindow[]=[{application:"us.zoom.xos",processID:41,windowID:42,title:"Synthetic call"}];
  const preflight=new DesktopAudioPreflight(inputs(),async()=>windows), port=await preflight.open(new AbortController().signal);
  try {
    await port.selectDesktopAudio!("meeting"); const id=port.getSnapshot().meetingWindows!.windows[0]!.id;
    await expect(Promise.resolve().then(()=>port.selectMeetingWindow!(crypto.randomUUID()))).rejects.toThrow();
    await port.selectMeetingWindow!(id);
    expect(JSON.stringify(port.getSnapshot())).not.toContain("processID");
    windows=[{...windows[0]!,title:"Updated title"}];await port.refreshMeetingWindows!();
    expect(port.getSnapshot().meetingWindows!.selectedId).toBeNull();
    const updated = port.getSnapshot().meetingWindows!.windows[0]!.id;
    expect(updated).not.toBe(id); await port.selectMeetingWindow!(updated);
    await port.refreshMeetingWindows!(); expect(port.getSnapshot().meetingWindows!.selectedId).toBe(updated);
    windows=[{...windows[0]!,processID:43}];await port.refreshMeetingWindows!();
    expect(port.getSnapshot().meetingWindows!.selectedId).toBeNull();
    expect(port.getSnapshot().meetingWindows!.windows[0]!.id).not.toBe(id);
  } finally { await port.close(); }
});
it("recommends one call without requesting access, admitting a recorder or processing audio, and clears ambiguity", async () => {
  const device = inputs(), request = vi.fn(), check = vi.fn(async () => undefined);
  Object.assign(device,{requestRecordingAccess:request,startCheck:check});
  const meet = {application:"com.google.Chrome" as const,processID:10,windowID:20,title:"Chrome — Meet - abc-defg-hij"};
  let windows: NativeMeetingWindow[] = [...Array.from({length:30},(_,n)=>({...meet,windowID:n+30,title:`Invented document ${n}`})),meet];
  const preflight = new DesktopAudioPreflight(device,async()=>windows), abort = new AbortController(), port = await preflight.open(abort.signal);
  try {
    await port.selectDesktopAudio!("meeting"); const selected = port.getSnapshot().meetingWindows!.selectedId!;
    expect(port.getSnapshot().meetingWindows!.windows).toHaveLength(31);
    expect(preflight.meetingWindowChoices.find(row=>row.id===selected)?.selection).toBe("recommended");
    expect(port.getSnapshot().microphone).toBeNull(); expect(request).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledOnce();
    windows=[...windows,{application:"us.zoom.xos",processID:11,windowID:21,title:"Zoom — Zoom Meeting"}];
    await port.refreshMeetingWindows!();expect(port.getSnapshot().meetingWindows!.selectedId).toBeNull();
    await port.selectMeetingWindow!(selected);await port.refreshMeetingWindows!();
    expect(port.getSnapshot().meetingWindows!.selectedId).toBe(selected);
    expect(preflight.meetingWindowChoices.find(row=>row.id===selected)?.selection).toBe("explicit");
    abort.abort(); expect(port.getSnapshot().meetingWindows!.selectedId).toBeNull();
    expect(preflight.selectedMeetingWindowId).toBeNull();
    expect(preflight.meetingWindowChoices.find(row=>row.id===selected)?.selection).toBe("explicit");
  } finally { await port.close(); }
});
it("re-evaluates changed titles and rejects stale opaque choices without a capture", async () => {
  const meet = {application:"com.google.Chrome" as const,processID:10,windowID:20,title:"Meet - abc-defg-hij"};
  let windows: NativeMeetingWindow[] = [meet];
  const preflight = new DesktopAudioPreflight(inputs(),async()=>windows), port = await preflight.open(new AbortController().signal);
  try {
    await port.selectDesktopAudio!("meeting");const old = port.getSnapshot().meetingWindows!.selectedId!;
    windows=[{...meet,title:"Meet - klm-nopq-rst"}];await port.refreshMeetingWindows!();
    expect(port.getSnapshot().meetingWindows!.selectedId).not.toBe(old);
    await expect(port.selectMeetingWindow!(old)).rejects.toThrow();
    windows=[{...meet,title:"Google Meet"}];await port.refreshMeetingWindows!();expect(port.getSnapshot().meetingWindows!.selectedId).toBeNull();
    await port.close();expect(port.getSnapshot().meetingWindows!.selectedId).toBeNull();
    await expect(port.refreshMeetingWindows!()).rejects.toThrow();
  } finally { await port.close(); }
});
it("does not let a late closed discovery erase another preparation's current choices", async () => {
  const pending=deferred<readonly NativeMeetingWindow[]>(), window={application:"us.zoom.xos" as const,processID:41,windowID:42,title:"Synthetic call"};
  const list=vi.fn().mockImplementationOnce(()=>pending.promise).mockResolvedValue([window]);
  const preflight=new DesktopAudioPreflight(inputs(),list), old=await preflight.open(new AbortController().signal);
  const discovery=old.selectDesktopAudio!("meeting"), rejected=expect(discovery).rejects.toThrow();
  await vi.waitFor(()=>expect(list).toHaveBeenCalledOnce());
  await old.close();
  const current=await preflight.open(new AbortController().signal);
  try {
    await current.selectDesktopAudio!("meeting"); const selected=current.getSnapshot().meetingWindows!.windows[0]!.id;
    await current.selectMeetingWindow!(selected);
    pending.resolve([]); await rejected;
    expect(current.getSnapshot().meetingWindows).toMatchObject({state:"ready",selectedId:selected,windows:[{id:selected,title:"Synthetic call"}]});
    expect(old.getSnapshot().meetingWindows?.selectedId).toBeNull();
  } finally { pending.resolve([]);await current.close(); }
});

it("keeps screen denial distinct from lookup failure and does not request access automatically", async () => {
  let denied = true;
  const request = vi.fn(async () => true), device = inputs();
  Object.assign(device,{requestRecordingAccess:request});
  const preflight = new DesktopAudioPreflight(device,async()=>{if(denied)throw new NativeScreenAccessRequired();return [];});
  const port = await preflight.open(new AbortController().signal);
  try {
    await expect(port.selectDesktopAudio!("meeting")).rejects.toThrow();
    expect(port.getSnapshot().meetingWindows?.state).toBe("permission_required");
    await expect(port.refreshMeetingWindows!()).rejects.toThrow();expect(request).not.toHaveBeenCalled();
    await expect(port.requestRecordingAccess!()).rejects.toThrow();
    expect(request).toHaveBeenCalledWith(expect.any(AbortSignal),false);
    denied=false;await port.requestRecordingAccess!();
    expect(port.getSnapshot()).toMatchObject({status:"ready",microphone:null,meetingWindows:{state:"ready",selectedId:null,windows:[]}});
  } finally {await port.close();}
  const failed = new DesktopAudioPreflight(inputs(),async()=>{throw new Error("invented lookup failure");});
  const other = await failed.open(new AbortController().signal);
  try {await expect(other.selectDesktopAudio!("meeting")).rejects.toThrow();expect(other.getSnapshot().meetingWindows?.state).toBe("unavailable");}
  finally {await other.close();}
});
it("cancels and joins an explicit setup helper before releasing preparation ownership",async()=>{
  const entered=deferred<void>(), exited=deferred<boolean>(), device=inputs();
  const start=vi.fn(async()=>undefined), request=vi.fn(async(signal:AbortSignal)=>{
    entered.resolve();expect(signal.aborted).toBe(false);return exited.promise;
  });Object.assign(device,{startCheck:start,requestRecordingAccess:request});
  const preflight=new DesktopAudioPreflight(device), port=await preflight.open(new AbortController().signal);
  const access=port.requestRecordingAccess!(), rejected=expect(access).rejects.toThrow();await entered.promise;
  await expect(port.selectDesktopAudio!("meeting")).rejects.toThrow();
  let closed=false;const close=port.close().then(()=>{closed=true;});await Promise.resolve();
  expect(request.mock.calls[0]![0].aborted).toBe(true);expect(closed).toBe(false);
  await expect(preflight.open(new AbortController().signal)).rejects.toThrow();
  exited.resolve(false);await rejected;await close;
  expect(start).toHaveBeenCalledOnce();expect(port.getSnapshot()).toMatchObject({status:"unavailable",microphone:null});
});
