import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AudioInputDevice, AudioPreflightSnapshot } from "../../capture/src/provider/audio-preflight";
import { verifyNativeHelper } from "./native-process-driver.js";
import { exactKeys, nativeCommand, nativeMetadata, NativeProcessDecoder } from "./native-process-wire.js";

interface Input { readonly id: string; readonly uid: string; readonly label: string; readonly kind: AudioInputDevice["kind"] }
interface Options {
  readonly helperPath: string; readonly helperSha256: string;
  readonly isSessionActive: () => boolean;
  readonly selectedUID?: string | null;
  readonly loadSelectedUID?: () => Promise<string | null>;
  readonly saveSelectedUID?: (uid: string) => Promise<void>;
}
type Child = ChildProcessByStdio<Writable, Readable, null>;
/** Main-only advisory input check. No PCM, recording grant, storage key, patient
 * or encounter crosses this service. close awaits observed helper exit before
 * clinical recording may acquire the microphone. Hardware UIDs stay private. */
export class NativeMicrophoneInputService {
  private inputs: Input[] = [];
  private selected: string | null;
  private status: AudioPreflightSnapshot["status"] = "unavailable";
  private level: { level: number; receivedAt: number } | null = null;
  private readonly listeners = new Set<(value: AudioPreflightSnapshot) => void>();
  private child: Child | null = null;
  private exited: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private abort: (() => void) | null = null;
  private signal: AbortSignal | null = null;
  private request = 0;
  private checkGeneration = 0;
  private preferenceLoaded = false;
  private pending: { id: number; uid: string; resolve(): void; reject(error: Error): void } | null = null;
  constructor(private readonly options: Options) { requireMain(); this.selected = options.selectedUID ?? null; }
  get selectedUID(): string | null { requireMain(); return this.selected; }
  getSnapshot(): AudioPreflightSnapshot {
    const selectedInputId = this.inputs.find(input => input.uid === this.selected)?.id ?? null;
    return { status: this.status, inputDevices: this.inputs.map(input => ({ id: input.id, label: input.label,
      kind: input.kind, current: input.id === selectedInputId })), selectedInputId,
      microphone: this.level ? { level: this.level.level, ageMs: Math.max(0, Math.floor(performance.now() - this.level.receivedAt)) } : null };
  }
  subscribe(listener: (snapshot: AudioPreflightSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener);
  }
  startCheck(signal: AbortSignal): Promise<void> {
    requireMain();
    if (this.opening || this.child || this.closing || signal.aborted || !this.options.isSessionActive()) return Promise.reject(failure());
    this.status = "checking"; this.level = null; this.publish();
    this.opening = this.open(signal, ++this.checkGeneration).catch(error => {
      this.status = "unavailable"; this.level = null; this.publish(); throw error;
    }).finally(() => { this.opening = null; });
    return this.opening;
  }
  private async open(signal: AbortSignal, generation: number): Promise<void> {
    if (!this.preferenceLoaded && this.options.loadSelectedUID) {
      const uid=await this.options.loadSelectedUID();
      if (signal.aborted || generation !== this.checkGeneration || !this.options.isSessionActive()) throw failure();
      if (uid !== null && !text(uid,511)) throw failure();
      this.selected=uid; this.preferenceLoaded=true;
    }
    await verifyNativeHelper(this.options);
    if (signal.aborted || generation !== this.checkGeneration || !this.options.isSessionActive()) throw failure();
    const child = spawn(this.options.helperPath, ["--microphone-check-v1"], {
      stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: dirname(this.options.helperPath), windowsHide: true,
    });
    this.child = child; this.signal = signal;
    const decoder = new NativeProcessDecoder();
    let sequence = 0, catalogSeen = false;
    const received: { uid: string; label: string; kind: AudioInputDevice["kind"] }[] = [];
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const invalidate = (): void => { this.status = "unavailable"; this.level = null; readyReject(failure());
      this.pending?.reject(failure()); this.pending = null; child.kill("SIGKILL"); this.publish(); };
    const startup = setTimeout(invalidate, 15_000);
    const heartbeat = setInterval(() => {
      if (!this.options.isSessionActive() || signal.aborted) { void this.close(); return; }
      try { this.send({ type: "heartbeat" }); } catch { invalidate(); }
    }, 5_000);
    this.abort = () => { void this.close(); };
    signal.addEventListener("abort", this.abort, { once: true });
    this.exited = new Promise<void>(resolve => {
      child.once("close", () => {
        clearTimeout(startup); clearInterval(heartbeat);
        try { decoder.finish(); } catch { this.status = "unavailable"; }
        readyReject(failure()); this.pending?.reject(failure()); this.pending = null;
        if (this.child === child) { this.child = null; this.level = null; }
        resolve(); this.publish();
      });
    });
    child.on("error", invalidate); child.stdin.on("error", invalidate);
    child.stdout.on("data", (bytes: Buffer) => {
      try {
        decoder.push(bytes, (kind, payload) => {
          if (kind !== 1) throw failure();
          const value = nativeMetadata(payload);
          switch (value.type) {
            case "input": {
              if (catalogSeen || !exactKeys(value, ["type", "device"]) || received.length >= 32) throw failure();
              const device = value.device as Record<string, unknown>;
              if (!device || typeof device !== "object" || !exactKeys(device, ["uid", "label", "kind"])
                || !text(device.uid, 511) || !text(device.label, 640) || [...device.label].length > 160
                || !["built_in", "bluetooth", "external", "unknown"].includes(device.kind as string)
                || received.some(input => input.uid === device.uid)) throw failure();
              received.push({ uid: device.uid, label: device.label, kind: device.kind as AudioInputDevice["kind"] }); return;
            }
            case "inputs": {
              if (catalogSeen || !exactKeys(value, ["type", "available", "count", "selectedUID"])
                || typeof value.available !== "boolean" || value.count !== received.length || !text(value.selectedUID, 511)) throw failure();
              catalogSeen = true;
              this.inputs = received.map(input => ({ ...input, id: this.inputs.find(old => old.uid === input.uid)?.id ?? crypto.randomUUID() }));
              this.selected ??= value.selectedUID;
              clearTimeout(startup);
              if (!value.available) { this.status = "permission_required"; readyResolve(); this.publish(); return; }
              const choice = this.inputs.find(input => input.uid === this.selected);
              if (!choice) { this.status = "unavailable"; readyResolve(); this.publish(); return; }
              void this.selectMicrophone(choice.id).then(readyResolve, readyReject); this.publish(); return;
            }
            case "selected": {
              const pending = this.pending;
              if (!catalogSeen || !pending || !exactKeys(value, ["type", "request", "uid"])
                || value.request !== pending.id || value.uid !== pending.uid) throw failure();
              this.pending = null; this.selected = pending.uid; this.status = "ready"; pending.resolve(); this.publish(); return;
            }
            case "selectionFailed": {
              const pending = this.pending;
              if (!pending || !exactKeys(value, ["type", "request"]) || value.request !== pending.id) throw failure();
              this.pending = null; this.level = null; this.status = "unavailable"; pending.reject(failure()); this.publish(); return;
            }
            case "checkLevel":
              if (!catalogSeen || !exactKeys(value, ["type", "sequence", "level"]) || value.sequence !== sequence + 1
                || typeof value.level !== "number" || !Number.isFinite(value.level) || value.level < 0 || value.level > 1) throw failure();
              sequence++; this.level = { level: value.level, receivedAt: performance.now() }; this.publish(); return;
            case "checkStopped":
              if (!this.closing || !exactKeys(value, ["type", "request"]) || value.request !== this.request) throw failure(); return;
            case "unavailable":
              if (!exactKeys(value, ["type"])) throw failure(); invalidate(); return;
            default: throw failure();
          }
        });
      } catch { invalidate(); }
    });
    try { await ready; } catch (error) {
      // An already observed child exit proves this advisory source is closed.
      // Do not join this.opening from its own rejection continuation.
      if (this.child === child) await this.close();
      throw error;
    }
  }
  async selectMicrophone(id: string): Promise<void> {
    requireMain();
    const input = this.inputs.find(value => value.id === id);
    if (!input || this.pending || this.closing || this.signal?.aborted || !this.options.isSessionActive()) throw failure();
    // With no checker running, retain a deliberate main-owned choice for the
    // next clinical start; the capture helper re-resolves the physical device.
    if (!this.child) { await this.options.saveSelectedUID?.(input.uid); this.selected = input.uid; this.publish(); return; }
    this.status = "checking"; this.level = null; this.publish();
    const request = ++this.request;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.pending = { id: request, uid: input.uid, resolve, reject };
        timer = setTimeout(() => { this.pending = null; reject(failure()); void this.close(); }, 15_000);
        this.send({ type: "selectMicrophone", request, microphoneUID: input.uid });
      });
      await this.options.saveSelectedUID?.(input.uid);
    } finally { clearTimeout(timer); }
  }
  close(): Promise<void> {
    requireMain();
    if (this.closing) return this.closing;
    this.checkGeneration++;
    const child = this.child, exited = this.exited;
    // Hash verification may still be awaiting the filesystem. Fence its late
    // continuation and join it before allowing recording to acquire the mic.
    if (!child || !exited) return this.opening?.catch(() => undefined) ?? Promise.resolve();
    this.level = null;
    this.closing = Promise.resolve().then(async () => {
      this.pending?.reject(failure()); this.pending = null;
      const request = ++this.request;
      this.send({ type: "stop", request, mode: "discard" });
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
      try { await exited; } finally { clearTimeout(timer); }
      if (this.signal && this.abort) this.signal.removeEventListener("abort", this.abort);
      this.signal = null; this.abort = null; this.exited = null;
    }).finally(() => { this.closing = null; this.publish(); });
    return this.closing;
  }
  private send(value: Record<string, unknown>): void {
    const frame = nativeCommand(value);
    const child = this.child;
    if (!child) { frame.fill(0); throw failure(); }
    try { child.stdin.write(frame, () => { frame.fill(0); }); } catch { frame.fill(0); throw failure(); }
  }
  private publish(): void { for (const listener of this.listeners) { try { listener(this.getSnapshot()); } catch { /* Advisory observer. */ } } }
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum
    && ![...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127);
}
function requireMain(): void {
  if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw failure();
}
function failure(): Error { return new Error("Microphone check is unavailable."); }
