import { expect, it, vi } from "vitest";
import { DesktopAudioPreflight } from "./desktop-audio-preflight.js";
import type { NativeMicrophoneInputService } from "./native-microphone-inputs.js";
import type { NativeMeetingWindow } from "./native-provider-presentation.js";

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
    expect(port.getSnapshot().meetingWindows!.selectedId).toBe(id);
    windows=[{...windows[0]!,processID:43}];await port.refreshMeetingWindows!();
    expect(port.getSnapshot().meetingWindows!.selectedId).toBeNull();
    expect(port.getSnapshot().meetingWindows!.windows[0]!.id).not.toBe(id);
  } finally { await port.close(); }
});
it("does not let a late closed discovery erase another preparation's current choices", async () => {
  const pending=deferred<readonly NativeMeetingWindow[]>(), window={application:"us.zoom.xos" as const,processID:41,windowID:42,title:"Synthetic call"};
  const list=vi.fn().mockImplementationOnce(()=>pending.promise).mockResolvedValue([window]);
  const preflight=new DesktopAudioPreflight(inputs(),list), old=await preflight.open(new AbortController().signal);
  const discovery=old.selectDesktopAudio!("meeting"), rejected=expect(discovery).rejects.toThrow();
  await old.close();
  const current=await preflight.open(new AbortController().signal);
  try {
    await current.selectDesktopAudio!("meeting"); const selected=current.getSnapshot().meetingWindows!.windows[0]!.id;
    await current.selectMeetingWindow!(selected);
    pending.resolve([]); await rejected;
    expect(current.getSnapshot().meetingWindows).toMatchObject({state:"ready",selectedId:selected,windows:[{id:selected,title:"Synthetic call"}]});
  } finally { pending.resolve([]);await current.close(); }
});
