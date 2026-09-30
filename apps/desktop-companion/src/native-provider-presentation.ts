import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { verifyNativeHelper, type AuthorizedDesktopSelection } from "./native-process-driver.js";
import { exactKeys, nativeCommand, nativeMetadata, NativeProcessDecoder } from "./native-process-wire.js";
import type { PersistentRecordingIndicator, RecordingIndicatorSnapshot } from "./recording-indicator.js";

export interface NativePresentationEvent {
  readonly kind: "stop_requested" | "failed";
  readonly sessionId: string | null;
}
export interface NativePresentationOwner {
  isHealthy(): boolean;
  onEvent(listener: (event: NativePresentationEvent) => void): () => void;
  dispose(): Promise<void>;
}
export interface NativePresentationOptions {
  readonly enabled?: boolean;
  readonly helperPath: string;
  readonly helperSha256: string;
  readonly isSessionActive: () => boolean;
  /** Exact main-owned CGWindowID; never a renderer visibility assertion. */
  readonly primaryWindowId?: () => number | null;
}
type Metadata = Record<string, unknown>;
type Selection = Omit<AuthorizedDesktopSelection, "captureAuthorizedUntil">;
type Child = ChildProcessByStdio<Writable, Readable, null>;
interface Pending {
  readonly response: ReturnType<typeof deferred<Metadata>>;
  readonly expected: string;
  timer?: ReturnType<typeof setTimeout>;
}
const TIMEOUT = 3_000;

/** Main-only native picker/indicator transport. Path and hash are fixed release
 * inputs. Titles, credentials, grants and audio never cross these pipes. */
export class NativeProviderPresentation implements PersistentRecordingIndicator, NativePresentationOwner {
  private readonly decoder = new NativeProcessDecoder();
  private readonly readiness = deferred<void>();
  private readonly exit = deferred<void>();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: NativePresentationEvent) => void>();
  private readonly child: Child;
  private sequence = 0;
  private choice: number | null = null;
  private cancellingChoice: number | null = null;
  private active: string | null = null;
  private phase: RecordingIndicatorSnapshot["phase"] = "inactive";
  private publishing = false;
  private ready = false;
  private broken = false;
  private exited = false;
  private closing = false;
  private closed = false;
  private closeAcknowledged = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private disposing: Promise<void> | undefined;

  private constructor(private readonly options: NativePresentationOptions) {
    this.child = spawn(options.helperPath, [options.primaryWindowId ? "--presentation-v2" : "--presentation-v1"], {
      stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: dirname(options.helperPath), windowsHide: true,
    });
    void this.readiness.promise.catch(() => undefined);
    this.child.stdout.on("data", (bytes: Buffer) => {
      if (this.broken) { bytes.fill(0); return; }
      try { this.decoder.push(bytes, (kind, payload) => {
        if (kind !== 1) throw unavailable();
        this.receive(nativeMetadata(payload));
      }); } catch { this.fail(); }
    });
    this.child.stdin.on("error", () => this.fail());
    this.child.on("error", () => this.fail());
    this.child.once("close", code => {
      this.exited = true; clearInterval(this.heartbeat);
      try { this.decoder.finish(); } catch { this.fail(); }
      if (!this.closeAcknowledged || code !== 0) this.fail();
      this.exit.resolve();
    });
  }

  static async open(options: NativePresentationOptions): Promise<NativeProviderPresentation> {
    requireMain();
    options = Object.freeze({ ...options });
    if (options.enabled !== true || !options.isSessionActive()) throw unavailable();
    await verifyNativeHelper(options);
    if (!options.isSessionActive()) throw unavailable();
    const owner = new NativeProviderPresentation(options);
    try {
      await bounded(owner.readiness.promise);
      if (!owner.isHealthy()) throw unavailable();
      owner.heartbeat = setInterval(() => {
        if (!owner.isHealthy()) { owner.fail(); return; }
        void owner.refreshPrimaryWindow().then(() => owner.request("heartbeat", "heartbeat").promise).catch(() => owner.fail());
      }, 1_000);
      return owner;
    } catch {
      owner.fail(); await owner.dispose(); throw unavailable();
    }
  }

  isHealthy(): boolean {
    try { return this.ready && !this.broken && !this.closing && !this.closed && !this.exited && this.options.isSessionActive(); }
    catch { return false; }
  }
  onEvent(listener: (event: NativePresentationEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  readonly selectWindow = async (signal: AbortSignal): Promise<Selection> => {
    requireMain();
    if (!this.isHealthy() || signal.aborted || this.choice !== null || this.active !== null || this.publishing) throw unavailable();
    const request = this.request("choose", "selected", {}, false);
    this.choice = request.id;
    const cancelled = deferred<never>();
    const cancel = (): void => {
      cancelled.reject(unavailable());
      if (this.choice !== request.id) return;
      this.cancellingChoice = request.id;
      this.send({ type: "cancel", request: request.id });
      const pending = this.pending.get(request.id);
      if (pending && !pending.timer) pending.timer = setTimeout(() => this.fail(), TIMEOUT);
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const value = await Promise.race([request.promise, cancelled.promise]);
      if (signal.aborted || !this.isHealthy()) throw unavailable();
      return Object.freeze({ application: value.application as Selection["application"],
        processID: value.processID as number, windowID: value.windowID as number });
    } finally { signal.removeEventListener("abort", cancel); }
  };

  /** Raise only the exact choice already pending in this native process. */
  readonly showWindowChooser = async (): Promise<void> => {
    requireMain();
    const choiceRequest = this.choice;
    if (!this.isHealthy() || choiceRequest === null || this.cancellingChoice !== null
      || this.active !== null || this.publishing) throw unavailable();
    await this.request("focusChooser", "chooserFocused", { choiceRequest }).promise;
  };

  async publish(snapshot: RecordingIndicatorSnapshot): Promise<void> {
    requireMain();
    snapshot = Object.freeze({ ...snapshot });
    if (!exactKeys({ ...snapshot }, ["visibility", "visible", "phase", "captureSessionId"])
      || snapshot.visibility !== "persistent" || this.publishing || this.closed || this.closing) throw unavailable();
    if (snapshot.phase === "inactive") {
      if (snapshot.visible !== false || snapshot.captureSessionId !== null) throw unavailable();
    } else if (!["recording", "failed"].includes(snapshot.phase) || snapshot.visible !== true
      || !uuid(snapshot.captureSessionId) || this.active !== null && this.active !== snapshot.captureSessionId
      || this.phase === "failed" && snapshot.phase === "recording") throw unavailable();
    this.publishing = true;
    try {
      if (snapshot.phase === "inactive" && !this.isHealthy()) {
        // Only the existing capture owner publishes inactive, after source stop.
        // Revoked admission must not prevent that owner's final cleanup. Retire
        // the same UI pipe without permitting another recording or picker.
        this.fail();
        await this.terminateInactive(); this.active = null; this.phase = "inactive"; return;
      }
      if (snapshot.phase === "inactive" && this.choice !== null && this.cancellingChoice === this.choice) {
        // Cancel returns to the recorder immediately, before the native pipe
        // can acknowledge that its picker closed. Let that bounded response
        // settle before publishing inactive; this race is not a broken helper.
        // A missing acknowledgement still fails at the existing cancel limit.
        await this.pending.get(this.choice)!.response.promise.catch(() => undefined);
      }
      if (!this.isHealthy() || this.choice !== null) throw unavailable();
      if (snapshot.phase !== "inactive") { this.active = snapshot.captureSessionId; this.phase = snapshot.phase; }
      if (snapshot.phase === "recording") await this.refreshPrimaryWindow();
      await this.request("publish", "published", { phase: snapshot.phase, session: snapshot.captureSessionId }).promise;
      if (snapshot.phase === "inactive") { this.active = null; this.phase = "inactive"; }
    } catch { this.fail(); throw unavailable(); }
    finally { this.publishing = false; }
  }

  dispose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // A stop failure keeps ownership. The caller must confirm capture shutdown
    // and publish inactive before it may release this native resource.
    if (this.active !== null || this.publishing) return Promise.reject(unavailable());
    return this.disposing ??= (async () => {
      this.closing = true; clearInterval(this.heartbeat);
      if (this.choice !== null) {
        const request = this.choice;
        this.send({ type: "cancel", request });
        await bounded(this.pending.get(request)!.response.promise).catch(() => this.fail());
      }
      if (!this.broken && !this.exited) {
        try {
          await this.request("close", "closed").promise;
          this.child.stdin.end(); await bounded(this.exit.promise);
        } catch { this.fail(); }
      }
      if (!this.exited) await this.terminateInactive();
      this.closed = true; this.listeners.clear();
    })().catch(error => { this.disposing = undefined; throw error; });
  }

  private async refreshPrimaryWindow(): Promise<void> {
    if (!this.options.primaryWindowId) return;
    const windowID = this.options.primaryWindowId();
    if (windowID !== null && !integer(windowID, 1, 4_294_967_295)) throw unavailable();
    await this.request("primaryWindow", "primaryWindow", { windowID }).promise;
  }

  private request(type: string, expected: string, fields: Metadata = {}, timed = true): { id: number; promise: Promise<Metadata> } {
    if (this.broken || this.exited || this.pending.size >= 8 || this.sequence >= 2_147_483_647) throw unavailable();
    const id = ++this.sequence, response = deferred<Metadata>();
    const pending: Pending = { expected, response };
    if (timed) pending.timer = setTimeout(() => this.fail(), TIMEOUT);
    this.pending.set(id, pending);
    this.send({ type, request: id, ...fields });
    return { id, promise: response.promise };
  }
  private send(value: Metadata): void {
    if (this.broken || this.exited) return;
    try { this.child.stdin.write(nativeCommand(value), error => { if (error) this.fail(); }); }
    catch { this.fail(); }
  }
  private receive(value: Metadata): void {
    if (value.type === "ready") {
      if (this.ready || !exactKeys(value, ["type", "version"]) || value.version !== (this.options.primaryWindowId ? 2 : 1)) throw unavailable();
      this.ready = true; this.readiness.resolve(); return;
    }
    if (!this.ready) throw unavailable();
    if (value.type === "stopRequested" || value.type === "visibilityLost") {
      if (!exactKeys(value, ["type", "session"]) || !uuid(value.session) || value.session !== this.active) throw unavailable();
      if (value.type === "visibilityLost") { this.phase = "failed"; this.fail(); }
      else this.emit({ kind: "stop_requested", sessionId: value.session });
      return;
    }
    if (!integer(value.request, 1, 2_147_483_647)) throw unavailable();
    const pending = this.pending.get(value.request);
    if (!pending || value.type !== pending.expected && value.type !== "unavailable") throw unavailable();
    if (value.type === "selected") {
      if (!exactKeys(value, ["type", "request", "application", "processID", "windowID"])
        || !["com.google.Chrome", "us.zoom.xos"].includes(value.application as string)
        || !integer(value.processID, 1, 2_147_483_647) || !integer(value.windowID, 1, 4_294_967_295)) throw unavailable();
    } else if (!exactKeys(value, ["type", "request"])) throw unavailable();
    clearTimeout(pending.timer); this.pending.delete(value.request);
    if (this.choice === value.request) { this.choice = null; this.cancellingChoice = null; }
    if (value.type === "closed") this.closeAcknowledged = true;
    if (value.type === "unavailable") pending.response.reject(unavailable());
    else pending.response.resolve(value);
  }
  private fail(): void {
    if (this.broken) return;
    this.broken = true; clearInterval(this.heartbeat); this.readiness.reject(unavailable());
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.response.reject(unavailable()); }
    this.pending.clear(); this.choice = null; this.cancellingChoice = null; this.decoder.clear();
    this.child.stdin.end();
    this.emit({ kind: "failed", sessionId: this.active });
  }
  private emit(event: NativePresentationEvent): void {
    for (const listener of this.listeners) { try { listener(Object.freeze(event)); } catch { /* Owner retains cleanup. */ } }
  }
  private async terminateInactive(): Promise<void> {
    if (!this.exited) { this.child.kill("SIGKILL"); await bounded(this.exit.promise); }
  }
}

function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value); }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function requireMain(): void {
  if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw unavailable();
}
function unavailable(): Error { return new Error("Native provider presentation is unavailable."); }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(unavailable()), TIMEOUT); })]); }
  finally { clearTimeout(timer); }
}
