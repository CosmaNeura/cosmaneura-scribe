import { afterEach, expect, it, vi } from "vitest";
import { openDesktopAudioPreflight } from "./desktop-audio-preflight";

const first=crypto.randomUUID(),second=crypto.randomUUID();
const initial=()=>({status:"ready",inputDevices:[],selectedInputId:null,microphone:{level:.25,ageMs:0},desktopAudio:"meeting",
  meetingWindows:{state:"ready",selectedId:first,windows:[{id:first,title:"Synthetic first call"},{id:second,title:"Synthetic second call"}]}});
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("cannot replace a newly selected call with an older delayed poll response",async()=>{
  vi.useFakeTimers();vi.stubGlobal("document",{visibilityState:"visible"});
  const oldRead=deferred<unknown>(),request=vi.fn(async(payload:Readonly<Record<string,unknown>>)=>{
    if(payload.action==="open")return initial();if(payload.action==="read")return oldRead.promise;
    if(payload.action==="window")return {...initial(),meetingWindows:{...initial().meetingWindows,selectedId:second}};
    return null;
  });
  const port=await openDesktopAudioPreflight(new AbortController().signal,request);
  try {
    await vi.advanceTimersByTimeAsync(250);expect(request).toHaveBeenCalledWith({action:"read"},expect.any(AbortSignal));
    await port.selectMeetingWindow!(second);expect(port.getSnapshot().meetingWindows?.selectedId).toBe(second);
    oldRead.resolve(initial());await vi.advanceTimersByTimeAsync(0);
    expect(port.getSnapshot().meetingWindows?.selectedId).toBe(second);
  }finally{oldRead.resolve(initial());await port.close();}
});
it("suppresses polling while a source choice is pending and clears the cached meter on revocation",async()=>{
  vi.useFakeTimers();vi.stubGlobal("document",{visibilityState:"visible"});
  const choice=deferred<unknown>(),abort=new AbortController();
  const request=vi.fn(async(payload:Readonly<Record<string,unknown>>)=>{
    if(payload.action==="open"||payload.action==="read")return initial();if(payload.action==="window")return choice.promise;return null;
  });
  const port=await openDesktopAudioPreflight(abort.signal,request),selected=port.selectMeetingWindow!(second);
  const rejected=expect(selected).rejects.toThrow();
  try {
    await vi.advanceTimersByTimeAsync(1000);
    expect(request.mock.calls.filter(([payload])=>payload.action==="read")).toHaveLength(0);
    abort.abort();await port.close();expect(port.getSnapshot()).toMatchObject({status:"unavailable",microphone:null});
    choice.resolve({...initial(),meetingWindows:{...initial().meetingWindows,selectedId:second}});await rejected;
    expect(port.getSnapshot().microphone).toBeNull();
  }finally{choice.resolve(initial());await selected.catch(()=>undefined);await port.close();}
});
