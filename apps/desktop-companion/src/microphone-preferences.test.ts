import { createCipheriv, createDecipheriv, randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { DeviceProtection } from "./device-custody.js";
import { microphonePreferenceScope, openMicrophonePreferences } from "./microphone-preferences.js";

const account={email:"invented-provider@example.invalid",environment:"Staging"};
// Real authenticated encryption behind the injected device-protection interface;
// this does not claim to exercise the installed application's macOS Keychain.
function protection(): DeviceProtection {
  const key=randomBytes(32);
  return {isEncryptionAvailable:()=>true,
    encryptString:value=>{const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
      const sealed=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),sealed]);},
    decryptString:value=>{const cipher=createDecipheriv("aes-256-gcm",key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));
      return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString("utf8");}};
}
async function directory(): Promise<string> {return realpath(await mkdtemp(join(tmpdir(),"scribe-input-preference-")));}
it("restores an actual device preference on cold launch while separating accounts and concealing UID/email from disk", async()=>{
  const path=await directory(), device=protection();
  try {
    const initial=await openMicrophonePreferences(path,device,account,new AbortController().signal);
    expect(await initial.load()).toBeNull();await initial.save("invented-usb-device-uid");await initial.close();
    const cold=await openMicrophonePreferences(path,device,account,new AbortController().signal);
    expect(await cold.load()).toBe("invented-usb-device-uid");await cold.close();
    const different=await openMicrophonePreferences(path,device,{...account,email:"another-invented-provider@example.invalid"},new AbortController().signal);
    expect(await different.load()).toBeNull();await different.close();
    for(const name of await readdir(path)) {
      expect(name).not.toContain(account.email);
      const bytes=await readFile(join(path,name));
      expect(bytes.includes(Buffer.from(account.email))).toBe(false);expect(bytes.includes(Buffer.from("invented-usb-device-uid"))).toBe(false);
    }
    await expect(openMicrophonePreferences(path,protection(),account,new AbortController().signal)).rejects.toThrow();
    expect(microphonePreferenceScope({...account,email:account.email.toUpperCase()})).toBe(microphonePreferenceScope(account));
  } finally {await rm(path,{recursive:true,force:true});}
});
it("cannot commit a delayed encrypted preference after backend revocation", async()=>{
  const path=await directory(), device=protection(), abort=new AbortController();
  let opened: Awaited<ReturnType<typeof openMicrophonePreferences>>|undefined;
  try {
    opened=await openMicrophonePreferences(path,device,account,abort.signal);await opened.save("invented-first-device");
    let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(done=>{release=done;}),encrypting=new Promise<void>(done=>{entered=done;});
    const original=webcrypto.subtle.encrypt.bind(webcrypto.subtle);
    const intercepted=vi.spyOn(webcrypto.subtle,"encrypt").mockImplementation(async(...arguments_)=>{entered();await gate;return original(...arguments_);});
    const saving=opened.save("invented-second-device"),rejected=expect(saving).rejects.toThrow();
    try {await encrypting;abort.abort();release();await rejected;}
    finally {release();intercepted.mockRestore();}
    await opened.close();opened=undefined;
    const cold=await openMicrophonePreferences(path,device,account,new AbortController().signal);
    expect(await cold.load()).toBe("invented-first-device");await cold.close();
  } finally {await opened?.close();await rm(path,{recursive:true,force:true});}
});
