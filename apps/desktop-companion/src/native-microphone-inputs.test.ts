import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { NativeMicrophoneInputService } from "./native-microphone-inputs.js";
import { sameMeetingWindow } from "./provider-recorder.js";

// Metadata-only child fixture. It has no audio source, PCM or consent/lease API.
const script = `#!${process.execPath}
if (process.argv[2] !== "--microphone-check-v1") process.exit(64);
function send(value) { const bytes=Buffer.from(JSON.stringify(value)), header=Buffer.alloc(5); header.writeUInt32BE(bytes.length+1); header[4]=1; process.stdout.write(Buffer.concat([header,bytes])); }
send({type:"input",device:{uid:"invented-default-device",label:"Built-in microphone",kind:"built_in"}});
send({type:"input",device:{uid:"invented-external-device",label:"USB microphone",kind:"external"}});
send({type:"inputs",available:true,count:2,selectedUID:"invented-default-device"});
let buffer=Buffer.alloc(0);
process.stdin.on("data", data => { buffer=Buffer.concat([buffer,data]); while(buffer.length>=4) {
 const size=buffer.readUInt32BE(0); if(buffer.length<4+size) return;
 const value=JSON.parse(buffer.subarray(5,4+size).toString()); buffer=buffer.subarray(4+size);
 if(value.type==="selectMicrophone") { send({type:"selected",request:value.request,uid:value.microphoneUID}); }
 else if(value.type==="stop") { send({type:"checkStopped",request:value.request}); setTimeout(()=>process.exit(0),80); }
 else if(value.type!=="heartbeat") process.exit(65);
} });
process.stdin.on("end",()=>process.exit(0));
`;
async function fixture(run: (options: {helperPath:string;helperSha256:string}) => Promise<void>, source=script): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-microphone-metadata-"))), helperPath = join(directory, "check");
  try { await writeFile(helperPath, source, {mode:0o700}); await run({helperPath,helperSha256:createHash("sha256").update(source).digest("hex")}); }
  finally { await rm(directory,{recursive:true,force:true}); }
}
describe("native advisory microphone ownership", () => {
  it("rejects an exited advisory child without hanging its own opening or retaining the microphone", async () => {
    await fixture(async helper => {
      const service = new NativeMicrophoneInputService({...helper,isSessionActive:()=>true});
      await expect(service.startCheck(new AbortController().signal)).rejects.toThrow();
      await service.close();
      expect(service.getSnapshot()).toMatchObject({status:"unavailable",microphone:null});
    }, `#!${process.execPath}\nprocess.exit(0);\n`);
  });
  it("keeps hardware UIDs main-only, persists actual choices and awaits helper exit before reuse", async () => {
    await fixture(async helper => {
      const saved = vi.fn(async () => undefined), service = new NativeMicrophoneInputService({...helper,isSessionActive:()=>true,saveSelectedUID:saved});
      try {
        await service.startCheck(new AbortController().signal);
        const initial=service.getSnapshot();
        expect(initial.status).toBe("ready"); expect(initial.inputDevices).toHaveLength(2);
        expect(JSON.stringify(initial)).not.toContain("invented-default-device");
        expect(service.getSnapshot().microphone).toBeNull();
        const external=initial.inputDevices.find(input=>input.kind==="external")!;
        await service.selectMicrophone(external.id);
        expect(service.selectedUID).toBe("invented-external-device"); expect(saved).toHaveBeenLastCalledWith("invented-external-device");
        const closing=service.close();
        await expect(service.startCheck(new AbortController().signal)).rejects.toThrow();
        await closing;
        expect(service.getSnapshot().microphone).toBeNull();
        await service.startCheck(new AbortController().signal);
        expect(service.getSnapshot().selectedInputId).toBe(external.id);
      } finally { await service.close(); }
    });
  });
  it("never accepts a live-level payload in catalogue-only preparation", async () => {
    const legacy = script.replace('send({type:"selected",request:value.request,uid:value.microphoneUID});',
      'send({type:"checkLevel",sequence:1,level:.25});');
    await fixture(async helper => {
      const service = new NativeMicrophoneInputService({...helper,isSessionActive:()=>true});
      await expect(service.startCheck(new AbortController().signal)).rejects.toThrow();
      await service.close();expect(service.getSnapshot().microphone).toBeNull();
    }, legacy);
  });
  it("advertises and deliberately selects hardware while denied without acquiring audio", async () => {
    await fixture(async helper => {
      const service = new NativeMicrophoneInputService({...helper,isSessionActive:()=>true});
      try {
        await service.startCheck(new AbortController().signal);
        expect(service.getSnapshot()).toMatchObject({status:"permission_required",microphone:null});
        const external=service.getSnapshot().inputDevices.find(input=>input.kind==="external")!;
        await service.selectMicrophone(external.id);
        expect(service.getSnapshot()).toMatchObject({status:"permission_required",selectedInputId:external.id,microphone:null});
      } finally { await service.close(); }
    }, script.replace('available:true','available:false'));
  });
  it("joins a cancelled helper verification and cannot spawn a late input check", async () => {
    await fixture(async helper => {
      const service = new NativeMicrophoneInputService({...helper,isSessionActive:()=>true});
      const opened=service.startCheck(new AbortController().signal);
      const rejected=expect(opened).rejects.toThrow();
      await service.close(); await rejected;
      expect(service.getSnapshot().microphone).toBeNull();
      await service.startCheck(new AbortController().signal); await service.close();
    });
  });
  it("does not silently replace a disappeared persisted input with the system default", async () => {
    await fixture(async helper => {
      const service = new NativeMicrophoneInputService({...helper,isSessionActive:()=>true,selectedUID:"invented-disconnected-device"});
      try { await service.startCheck(new AbortController().signal); expect(service.getSnapshot()).toMatchObject({status:"unavailable",selectedInputId:null,microphone:null}); }
      finally { await service.close(); }
    });
  });
});
it("a matching call title cannot authorize a replacement process, window or application", () => {
  const selected={application:"us.zoom.xos" as const,processID:41,windowID:42,title:"Invented call"};
  expect(sameMeetingWindow(selected,{...selected,title:"Updated call title"})).toBe(true);
  expect(sameMeetingWindow(selected,{...selected,processID:43})).toBe(false);
  expect(sameMeetingWindow(selected,{...selected,windowID:43})).toBe(false);
  expect(sameMeetingWindow(selected,{...selected,application:"com.google.Chrome"})).toBe(false);
});
