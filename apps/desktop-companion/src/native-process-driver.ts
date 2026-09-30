import { parseNativeProcessFence, type NativeProcessFence } from "./native-process-fence.js";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { DesktopPCMDriver, DesktopPCMDriverSession, DesktopPCMFailure,
  DesktopPCMStart, DesktopPCMCompletion, DesktopCaptureAuthorization } from "./native-pcm-driver.js";
import { parseDesktopPCMStart, parseDesktopPCMCompletion } from "./pcm-capture-source.js";
import { NativeProcessDecoder, nativeCommand, nativeMetadata, exactKeys } from "./native-process-wire.js";
import type { RuntimeDiagnostic } from "./runtime-diagnostics.js";

export interface AuthorizedDesktopSelection {
  readonly application: "com.google.Chrome" | "us.zoom.xos";
  readonly processID: number;
  readonly windowID: number;
  readonly captureAuthorizedUntil: number;
}
export interface NativeProcessDriverOptions {
  /** Existing companion enablement; false/omitted never executes a helper. */
  readonly enabled?: boolean;
  readonly helperPath: string;
  readonly helperSha256: string;
  /** Observed native workstation state, supplied by the trusted host. */
  readonly isSessionActive: () => boolean;
  /** Fresh existing capability/consent/lease/indicator authority. No credentials
   * or renderer-supplied authority fields are passed through the pipe. */
  readonly authorizeSelectedWindow: () => Promise<AuthorizedDesktopSelection>;
  /** Required for actual capture-v2 starts; supplied only by the native backend. */
  readonly getProcessFence?: () => NativeProcessFence;
  /** Fixed local event metadata only; diagnostics cannot affect capture cleanup. */
  readonly diagnostics?: RuntimeDiagnostic;
}
type Child = ChildProcessByStdio<Writable, Readable, null>;
type Sink = Parameters<DesktopPCMDriver["start"]>[1];
const DEADLINE_MS = 15_000;
const MAX_FRAMES = 1_382_400_000;
const CODES: readonly DesktopPCMFailure[] = ["permission_required", "device_changed", "session_locked",
  "clock_discontinuity", "overflow", "failed"];

/** Main process only. The packaged helper path/hash are release inputs, never an
 * IPC argument. This source preparation does not establish signing acceptance. */
export class NativeProcessPCMDriver implements DesktopPCMDriver {
  private readonly options: NativeProcessDriverOptions;
  constructor(options: NativeProcessDriverOptions) { requireMain(); this.options = Object.freeze({ ...options }); }
  async getAvailability(): Promise<boolean> {
    requireMain();
    try {
      if (!this.options.enabled || !this.options.isSessionActive()) return false;
      await verifyNativeHelper(this.options);
      if (!this.options.isSessionActive()) return false;
      return await probe(this.options.helperPath) && this.options.isSessionActive();
    } catch { return false; }
  }
  /** Explicit provider setup only. This helper mode cannot start an audio source. */
  async requestPermissions(signal: AbortSignal): Promise<boolean> {
    requireMain();
    try {
      if (!this.options.enabled || signal.aborted || !this.options.isSessionActive()) return false;
      await verifyNativeHelper(this.options);
      if (signal.aborted || !this.options.isSessionActive()) return false;
      return await probe(this.options.helperPath, signal) && !signal.aborted && this.options.isSessionActive();
    } catch { return false; }
  }
  start(configuration: Parameters<DesktopPCMDriver["start"]>[0], sink: Sink): DesktopPCMDriverSession {
    requireMain();
    if (!this.options.enabled || !this.options.isSessionActive() || configuration.sampleRateHz !== 16_000
      || !integer(configuration.maximumOutputFrames, 1, MAX_FRAMES)) throw failure();
    return new ProcessSession(this.options, configuration.maximumOutputFrames, sink, configuration.authorization);
  }
}

class ProcessSession implements DesktopPCMDriverSession {
  private readonly readiness = deferred<DesktopPCMStart>();
  readonly ready = this.readiness.promise;
  private readonly exited = deferred<void>();
  private child?: Child;
  private readonly decoder = new NativeProcessDecoder();
  private startValue?: DesktopPCMStart;
  private completion: DesktopPCMCompletion | null = null;
  private active = false;
  private cancelled = false;
  private failed = false;
  private receivedFrames = 0;
  private inputSequence = 0;
  private receiving = false;
  private packetWork = Promise.resolve();
  private exitObserved = false;
  private closingInput = false;
  private confirmed = false;
  private stopReported = false;
  private request = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private captureTimer?: ReturnType<typeof setTimeout>;
  private authorization: DesktopCaptureAuthorization | undefined;
  private renewalRequest = 0;
  private renewalsClosed = false;
  private pendingExtension: { request: number; authorization: DesktopCaptureAuthorization;
    response: ReturnType<typeof deferred<void>> } | undefined;
  private readonly stops = new Map<number, { readonly mode: "drain" | "discard";
    readonly response: ReturnType<typeof deferred<DesktopPCMCompletion | null>> }>();

  constructor(private readonly options: NativeProcessDriverOptions, private maximumFrames: number, private readonly sink: Sink,
    authorization?: DesktopCaptureAuthorization) {
    this.authorization = authorization ? checkedAuthorization(authorization, maximumFrames) : undefined;
    // The handle exists before the first asynchronous authorization/file read.
    void this.ready.catch(() => undefined);
    this.diagnose("audio_start_pending");
    this.startupTimer = setTimeout(() => {
      if (!this.failed && !this.cancelled) this.diagnose("audio_start_timeout");
      this.fail("failed");
    }, DEADLINE_MS);
    void this.prepare().catch(() => { this.fail("failed"); });
  }
  private async prepare(): Promise<void> {
    const selection = Object.freeze({ ...await this.options.authorizeSelectedWindow() });
    if (this.cancelled) return;
    await verifyNativeHelper(this.options);
    if (this.cancelled) return;
    const duration = Math.floor((selection.captureAuthorizedUntil - Date.now()) / 1000);
    if (!this.options.isSessionActive() || !exactKeys({ ...selection },
      ["application", "processID", "windowID", "captureAuthorizedUntil"])
      || !["com.google.Chrome", "us.zoom.xos"].includes(selection.application)
      || !integer(selection.processID, 1, 2_147_483_647) || !integer(selection.windowID, 1, 4_294_967_295)
      || !Number.isSafeInteger(selection.captureAuthorizedUntil) || !integer(duration, 1, 86_400)) throw failure();
    if (this.authorization) {
      this.authorization = checkedAuthorization(this.authorization, this.maximumFrames);
      if (this.authorization.expiresAtMilliseconds !== selection.captureAuthorizedUntil) throw failure();
    } else this.maximumFrames = Math.min(this.maximumFrames, duration * 16_000);
    const processFence = parseNativeProcessFence(this.options.getProcessFence?.());
    const child = launch(this.options.helperPath, this.authorization ? "--capture-v3" : "--capture-v2");
    this.child = child;
    child.once("spawn", () => { this.diagnose("audio_helper_spawned"); });
    child.stdout.on("data", (bytes: Buffer) => {
      try { this.decoder.push(bytes, (kind, payload) => { this.receive(kind, payload); }); }
      catch { this.breakTransport(); }
    });
    child.stdin.on("error", () => { this.breakTransport(); });
    child.on("error", () => { this.fail("failed"); });
    child.once("close", () => {
      this.exitObserved = true; clearInterval(this.heartbeat); clearTimeout(this.startupTimer); clearTimeout(this.captureTimer);
      try { this.decoder.finish(); } catch { this.fail("failed"); }
      if (!this.confirmed) this.fail("failed");
      this.readiness.reject(failure()); this.pendingExtension?.response.reject(failure());
      // An owned child's observed exit proves cessation for discard, even if
      // its last reply was lost. It cannot prove a drained audio completion.
      for (const stop of this.stops.values()) {
        if (stop.mode === "discard") stop.response.resolve(null);
        else stop.response.reject(failure());
      }
      this.stops.clear(); this.exited.resolve();
    });
    if (this.authorization) {
      this.send({ type: "startRenewable", application: selection.application, processID: selection.processID,
        windowID: selection.windowID, authorization: this.authorization, processFence });
    } else this.send({ type: "start", application: selection.application, processID: selection.processID,
      windowID: selection.windowID, maximumDurationSeconds: duration, maximumOutputFrames: this.maximumFrames, processFence });
    this.captureTimer = setTimeout(() => { this.fail("failed"); }, Math.max(0, selection.captureAuthorizedUntil - Date.now()));
    this.heartbeat = setInterval(() => {
      if (this.closingInput) return;
      try {
        if (!this.options.isSessionActive()) this.fail("session_locked");
        else this.send({ type: "heartbeat" });
      } catch { this.fail("failed"); }
    }, 5_000);
  }
  activate(): void {
    if (!this.startValue || this.active || this.cancelled || this.closingInput || this.exitObserved) throw failure();
    if (!this.options.isSessionActive()) { this.fail("session_locked"); throw failure(); }
    this.active = true; this.send({ type: "activate" });
  }
  async extend(value: DesktopCaptureAuthorization): Promise<void> {
    if (!this.authorization || !this.active || this.failed || this.cancelled || this.renewalsClosed
      || this.closingInput || this.exitObserved || this.pendingExtension || !this.options.isSessionActive()) throw failure();
    const next = checkedAuthorization(value, value.maximumOutputFrames, this.authorization);
    if (next.generation === this.authorization.generation) return;
    if (this.renewalRequest >= 1_000_000) throw failure();
    const response = deferred<void>();
    const request = ++this.renewalRequest;
    this.pendingExtension = { request, authorization: next, response };
    this.maximumFrames = next.maximumOutputFrames;
    this.send({ type: "extend", request, authorization: next });
    try { await deadline(response.promise); }
    catch (error) { if (!this.renewalsClosed) this.fail("failed"); throw error; }
  }
  stop(options: { readonly mode: "drain" | "discard" }): Promise<DesktopPCMCompletion | null> {
    this.renewalsClosed = true; this.pendingExtension?.response.reject(failure());
    if (options.mode === "discard" || !this.active) {
      this.cancelled = true; this.readiness.reject(failure());
    }
    // Cancellation before spawn is definitive: prepare checks it after every await.
    if (!this.child) { this.cancelled = true; clearTimeout(this.startupTimer); return Promise.resolve(null); }
    if (this.exitObserved || this.closingInput) return deadline(this.finishStop(this.cancelled ? null : this.completion));
    if (this.stops.size >= 4 || this.request >= 32) return Promise.reject(failure());
    const request = ++this.request;
    const response = deferred<DesktopPCMCompletion | null>();
    const mode = this.cancelled ? "discard" : "drain";
    this.stops.set(request, { mode, response });
    this.send({ type: "stop", request, mode });
    // Timeout rejects this caller, but retains the request/child for reconciliation.
    // It never kills/restarts recording or pretends that an OS stop was confirmed.
    return deadline(response.promise.then(value => this.finishStop(value)));
  }
  private async finishStop(value: DesktopPCMCompletion | null): Promise<DesktopPCMCompletion | null> {
    await this.exited.promise;
    await this.packetWork;
    if (!this.cancelled && !this.confirmed) throw failure();
    if (this.confirmed && !this.stopReported) { this.stopReported = true; this.diagnose("audio_stop_confirmed"); }
    return this.cancelled ? null : value;
  }
  private receive(kind: number, payload: Buffer): void {
    if (kind === 2) {
      if (this.cancelled) return;
      const firstFrame = payload.readUInt32BE(0), frames = (payload.length - 4) / 2;
      if (!this.active || this.receiving || this.confirmed || firstFrame !== this.receivedFrames
        || this.receivedFrames + frames > this.maximumFrames) throw failure();
      const bytes = new Uint8Array(payload.length - 4); bytes.set(payload.subarray(4));
      this.receivedFrames += frames; this.receiving = true;
      this.packetWork = Promise.resolve().then(async () => {
        try {
          if (!this.cancelled) await this.sink.onPcmPacket({ firstFrame, pcmBytes: bytes });
          if (!this.cancelled) this.send({ type: "ack", firstFrame });
        } catch { this.fail("failed"); }
        finally { bytes.fill(0); this.receiving = false; }
      });
      return;
    }
    const value = nativeMetadata(payload);
    switch (value.type) {
      case "inputSignal": {
        if (!exactKeys(value, ["type", "sequence", "channel", "level"])
          || !integer(value.sequence, this.inputSequence + 1, Number.MAX_SAFE_INTEGER)
          || value.sequence !== this.inputSequence + 1
          || value.channel !== "microphone" && value.channel !== "meetingAudio"
          || typeof value.level !== "number" || !Number.isFinite(value.level) || value.level < 0 || value.level > 1) throw failure();
        this.inputSequence = value.sequence;
        if (this.active && !this.failed && !this.cancelled && !this.confirmed && !this.renewalsClosed) {
          try { this.sink.onInputSignal?.({ channel: value.channel, level: value.level }); } catch { /* Meter is advisory. */ }
        }
        return;
      }
      case "extended": {
        const pending = this.pendingExtension;
        if (!pending || !exactKeys(value, ["type", "request", "generation"])
          || value.request !== pending.request || value.generation !== pending.authorization.generation) throw failure();
        this.pendingExtension = undefined;
        if (this.renewalsClosed || this.failed || this.cancelled || this.exitObserved) { pending.response.reject(failure()); return; }
        this.authorization = pending.authorization;
        clearTimeout(this.captureTimer);
        this.captureTimer = setTimeout(() => { this.fail("failed"); }, Math.max(0, this.authorization.expiresAtMilliseconds - Date.now()));
        pending.response.resolve(); return;
      }
      case "ready":
        if (!exactKeys(value, ["type", "start"]) || this.startValue || this.confirmed) throw failure();
        if (this.cancelled) return;
        this.startValue = parseDesktopPCMStart(value.start); clearTimeout(this.startupTimer);
        this.diagnose("audio_ready");
        this.readiness.resolve(this.startValue); return;
      case "failure":
        if (!exactKeys(value, ["type", "code"]) || !CODES.includes(value.code as DesktopPCMFailure)) throw failure();
        this.fail(value.code as DesktopPCMFailure); return;
      case "stopped":
      case "stopFailed": {
        if (!exactKeys(value, value.type === "stopped" ? ["type", "request", "completion"] : ["type", "request"])
          || !integer(value.request, 1, 32)) throw failure();
        const stop = this.stops.get(value.request);
        if (!stop) throw failure();
        if (value.type === "stopFailed") {
          this.stops.delete(value.request); stop.response.reject(failure()); return;
        }
        if (!this.cancelled) {
          if (!this.startValue || value.completion === null || this.receiving) throw failure();
          this.completion = parseDesktopPCMCompletion(value.completion, this.startValue, this.receivedFrames);
        } else if (value.completion !== null) {
          // A drain receipt may already be in the pipe when discard is requested.
          const completion = value.completion as Partial<DesktopPCMCompletion> | undefined;
          if (stop.mode !== "drain" || !this.startValue || !integer(completion?.outputFrames, 1, this.maximumFrames)) throw failure();
          parseDesktopPCMCompletion(value.completion, this.startValue, completion.outputFrames);
        }
        this.stops.delete(value.request);
        this.confirmed = true; stop.response.resolve(this.cancelled ? null : this.completion);
        if (this.stops.size === 0) {
          this.closingInput = true; clearInterval(this.heartbeat); clearTimeout(this.startupTimer); clearTimeout(this.captureTimer);
          this.child?.stdin.end();
        }
        return;
      }
      default: throw failure();
    }
  }
  private send(value: Readonly<Record<string, unknown>>): void {
    if (!this.child || this.closingInput || this.exitObserved) return;
    try { this.child.stdin.write(nativeCommand(value)); }
    catch { this.fail("failed"); }
  }
  private fail(code: DesktopPCMFailure): void {
    if (this.failed) return;
    this.failed = true; this.readiness.reject(failure());
    // Begin cleanup before notifying the existing capture controller.
    void this.stop({ mode: "discard" }).catch(() => undefined);
    this.diagnose(`audio_${code}`);
    try { this.sink.onFailure(code); } catch { /* Cleanup remains owned here. */ }
  }
  private diagnose(event: Parameters<RuntimeDiagnostic>[0]): void {
    try { this.options.diagnostics?.(event); } catch { /* Observation cannot affect source ownership. */ }
  }
  private breakTransport(): void {
    this.fail("failed"); this.decoder.clear();
    // A corrupted pipe cannot carry a trustworthy stop receipt. EOF makes the
    // dedicated helper stop or exit at its bounded parent-loss deadline.
    this.closingInput = true; clearInterval(this.heartbeat); clearTimeout(this.startupTimer); clearTimeout(this.captureTimer);
    // Retain pending discards until close observes actual child exit. Callers
    // still have their bounded deadline if the helper has not exited.
    this.child?.stdin.end();
  }
}

function launch(path: string, mode: string): Child {
  return spawn(path, [mode], { stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: dirname(path), windowsHide: true });
}
export async function verifyNativeHelper(options: Pick<NativeProcessDriverOptions, "helperPath" | "helperSha256">): Promise<void> {
  if (!isAbsolute(options.helperPath) || !/^[a-f0-9]{64}$/u.test(options.helperSha256)
    || await realpath(options.helperPath) !== options.helperPath) throw failure();
  const file = await open(options.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const bytes = Buffer.alloc(65_536);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 134_217_728
      || (before.mode & 0o022) !== 0 || (before.mode & 0o111) === 0) throw failure();
    const hash = createHash("sha256");
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > before.size) throw failure();
      hash.update(bytes.subarray(0, bytesRead)); bytes.fill(0);
    }
    const after = await lstat(options.helperPath);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || length !== before.size || hash.digest("hex") !== options.helperSha256) throw failure();
  } finally { bytes.fill(0); await file.close(); }
}
async function probe(path: string, permissionSignal?: AbortSignal): Promise<boolean> {
  if (permissionSignal?.aborted) return false;
  return await new Promise<boolean>(resolve => {
    const child = launch(path, permissionSignal ? "--request-permissions-v1" : "--availability-v1");
    const decoder = new NativeProcessDecoder();
    let available: boolean | undefined;
    // Neither probe mode records. OS setup may wait for an explicit user choice;
    // recording and read-only availability keep their existing deadlines.
    const cancel = (): void => { available = false; child.kill("SIGKILL"); };
    const timer = setTimeout(cancel, permissionSignal ? 120_000 : DEADLINE_MS);
    permissionSignal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (bytes: Buffer) => {
      try {
        decoder.push(bytes, (kind, payload) => {
          const value = nativeMetadata(payload);
          if (kind !== 1 || available !== undefined || !exactKeys(value, ["type", "available"])
            || value.type !== "availability" || typeof value.available !== "boolean") throw failure();
          available = value.available;
        });
      } catch { available = false; child.kill("SIGKILL"); }
    });
    child.stdin.on("error", () => undefined);
    child.on("error", () => { available = false; });
    child.once("close", code => {
      clearTimeout(timer);
      permissionSignal?.removeEventListener("abort", cancel);
      try { decoder.finish(); } catch { available = false; }
      resolve(code === 0 && available === true && !permissionSignal?.aborted);
    });
    child.stdin.end();
  });
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function requireMain(): void {
  if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw failure();
}
function failure(): Error { return new Error("desktop_native_process_failed"); }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: Error) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => { reject(failure()); }, DEADLINE_MS); })]); }
  finally { clearTimeout(timer); }
}

function checkedAuthorization(value: DesktopCaptureAuthorization, maximumFrames: number,
  previous?: DesktopCaptureAuthorization): DesktopCaptureAuthorization {
  if (!value || !exactKeys({ ...value }, ["runId", "generation", "expiresAtMilliseconds", "maximumOutputFrames", "hardMaximumOutputFrames"])
    || typeof value.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.runId)
    || !integer(value.generation, 1, Number.MAX_SAFE_INTEGER)
    || !Number.isSafeInteger(value.expiresAtMilliseconds) || value.expiresAtMilliseconds <= Date.now()
    || value.expiresAtMilliseconds - Date.now() > 905_000
    || !integer(value.hardMaximumOutputFrames, 1, MAX_FRAMES)
    || !integer(value.maximumOutputFrames, 1, value.hardMaximumOutputFrames)
    || value.maximumOutputFrames !== maximumFrames) throw failure();
  if (previous) {
    if (previous.expiresAtMilliseconds <= Date.now() || value.runId !== previous.runId
      || value.hardMaximumOutputFrames !== previous.hardMaximumOutputFrames
      || value.maximumOutputFrames < previous.maximumOutputFrames
      || value.maximumOutputFrames - previous.maximumOutputFrames > 905 * 16_000) throw failure();
    const duplicate = value.generation === previous.generation && value.expiresAtMilliseconds === previous.expiresAtMilliseconds
      && value.maximumOutputFrames === previous.maximumOutputFrames;
    if (!duplicate && (value.generation !== previous.generation + 1 || value.expiresAtMilliseconds <= previous.expiresAtMilliseconds)) throw failure();
  } else if (value.generation !== 1 || value.maximumOutputFrames > 905 * 16_000) throw failure();
  return Object.freeze({ ...value });
}
