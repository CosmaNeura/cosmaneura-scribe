import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { NativeProviderSession, ProviderSessionState } from "../../capture/src/provider/native-plugin";
import { exact, object, sessionState } from "../../capture/src/provider/desktop-host-protocol";
import { verifyNativeHelper } from "./native-process-driver.js";

const MAX_FRAME = 16 * 1024 * 1024;
type Child = ChildProcessByStdio<Writable, Readable, null>;
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Fixed, verified native helper. No token or endpoint enters the renderer API. */
export class NativeProviderClient implements NativeProviderSession {
  private readonly child: Child;
  private readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, Pending>();
  private readonly retired = new Set<string>();
  private readonly listeners = new Set<(state: ProviderSessionState) => void>();
  private state: ProviderSessionState | null = null;
  private closing: Promise<void> | null = null;
  private readonly exit: Promise<void>;
  private exited = false;
  private poll?: ReturnType<typeof setInterval>;
  private checking = false;
  private observations = 0;

  private constructor(path: string) {
    this.child = spawn(path, ["--provider-v1"], {
      stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: dirname(path), windowsHide: true,
    });
    this.exit = new Promise(resolve => this.child.once("close", () => {
      this.exited = true; this.fail(); resolve();
    }));
    this.child.on("error", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("data", (bytes: Buffer) => {
      try {
        if (this.buffer.length + bytes.length > MAX_FRAME) throw unavailable();
        this.buffer = Buffer.concat([this.buffer, bytes]);
        let end: number;
        while ((end = this.buffer.indexOf(10)) !== -1) {
          const frame = this.buffer.subarray(0, end);
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
          this.receive(value); frame.fill(0); this.buffer = this.buffer.subarray(end + 1);
        }
      } catch { this.fail(); }
      finally { bytes.fill(0); }
    });
  }

  static async open(options: { helperPath: string; helperSha256: string }): Promise<NativeProviderClient> {
    requireMain(); await verifyNativeHelper(options);
    const owner = new NativeProviderClient(options.helperPath);
    try {
      await owner.getState();
      owner.poll = setInterval(() => {
        if (owner.checking || owner.signal.aborted) return;
        owner.checking = true;
        void owner.getState().catch(() => owner.fail()).finally(() => { owner.checking = false; });
      }, 1_000);
      return owner;
    } catch { await owner.dispose(); throw unavailable(); }
  }

  isReady(): boolean { return !this.signal.aborted && this.state?.phase === "ready"; }
  async getState(): Promise<ProviderSessionState> { return this.readState("getState", 35_000); }
  async signIn(): Promise<ProviderSessionState> { return this.readState("signIn", 185_000); }
  async signOut(): Promise<ProviderSessionState> { return this.readState("signOut", 35_000); }
  addListener(_event: "authStateChanged", listener: (state: ProviderSessionState) => void): Promise<{ remove(): Promise<void> }> {
    this.listeners.add(listener);
    return Promise.resolve({ remove: () => { this.listeners.delete(listener); return Promise.resolve(); } });
  }

  request(method: "getState" | "signIn" | "signOut" | "providerRequest" | "sourcePrepare"
    | "sourceAuthorize" | "sourceRelease" | "sourceStopped" | "sourcePreparationRelease", payload: Record<string, unknown>, signal?: AbortSignal,
    timeout = 35_000): Promise<unknown> {
    requireMain();
    if (this.signal.aborted || signal?.aborted || this.pending.size >= 8) return Promise.reject(unavailable());
    const id = crypto.randomUUID(), bytes = Buffer.from(JSON.stringify({ id, method, payload }) + "\n");
    if (bytes.length > MAX_FRAME) { bytes.fill(0); return Promise.reject(unavailable()); }
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); this.retired.add(id); pending.cleanup(); reject(unavailable());
        if (this.retired.size > 256) this.fail();
      };
      const timer = setTimeout(cancel, timeout);
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); bytes.fill(0); return; }
      this.child.stdin.write(bytes, error => { bytes.fill(0); if (error) this.fail(); });
    });
  }

  dispose(): Promise<void> {
    return this.closing ??= (async () => {
      this.fail(); this.child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.exit, new Promise<void>(resolve => {
          timer = setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); resolve(); }, 3_000);
        })]);
        await this.exit;
      } finally { clearTimeout(timer); this.buffer.fill(0); this.listeners.clear(); }
    })();
  }

  private receive(input: unknown): void {
    const value = object(input);
    if (value.event === "authStateChanged") {
      exact(value, ["event", "state"]); this.accept(value.state); return;
    }
    exact(value, ["id", "ok", "result"]);
    if (typeof value.id !== "string" || typeof value.ok !== "boolean") throw unavailable();
    const pending = this.pending.get(value.id);
    if (!pending) { if (this.retired.delete(value.id)) return; throw unavailable(); }
    this.pending.delete(value.id); pending.cleanup();
    if (value.ok) pending.resolve(value.result); else pending.reject(unavailable());
  }
  private async readState(method: "getState" | "signIn" | "signOut", timeout: number): Promise<ProviderSessionState> {
    const observation = this.observations;
    const reply = await this.request(method, {}, undefined, timeout);
    if (observation === this.observations) this.accept(reply);
    if (!this.state || this.signal.aborted) throw unavailable();
    return this.state;
  }
  private accept(value: unknown): ProviderSessionState {
    const next = sessionState(value);
    const changed = next.phase !== this.state?.phase || next.revision !== this.state.revision;
    this.observations += 1; this.state = next;
    if (changed) for (const listener of this.listeners) listener(next);
    return next;
  }
  private fail(): void {
    if (this.signal.aborted) return;
    this.abort.abort(); clearInterval(this.poll);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(unavailable()); }
    this.pending.clear();
  }
}

function requireMain(): void {
  if (typeof window !== "undefined" || !process.versions.node
    || "type" in process && process.type === "renderer") throw unavailable();
}
function unavailable(): Error { return new Error("provider_native_unavailable"); }
