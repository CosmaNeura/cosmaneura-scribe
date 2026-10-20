import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Fixed bootstrap stages only. No error, path, identity or payload is logged. */
export type StoreBootstrapStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;
export class StoreBootstrapDiagnostics {
  private stage: StoreBootstrapStage = 1;
  private directory: string | undefined;
  private bridgeReason: number | undefined;
  private bridgeExit: number | undefined;
  private bridgeSignal: number | undefined;
  private failure: Promise<void> | undefined;
  constructor(private readonly writeFixed: (line: string) => void = line => { process.stderr.write(line); }) {}
  enter(stage: StoreBootstrapStage): void {
    if (Number.isSafeInteger(stage) && stage >= 1 && stage <= 17) this.stage = stage;
  }
  /** Called only after the existing Store child custody checks have passed. */
  bindValidatedDirectory(directory: string): void { this.directory = directory; }
  observeBridge(event: string, code: number | undefined): void {
    if (!Number.isSafeInteger(code)) return;
    if (event === "store_bridge_failed" && code! >= 1 && code! <= 12) this.bridgeReason ??= code;
    if (event === "store_bridge_exit" && code! >= 0 && code! <= 255) this.bridgeExit ??= code;
    if (event === "store_bridge_signal" && code! >= 1 && code! <= 3) this.bridgeSignal ??= code;
  }
  failed(): Promise<void> { return this.failure ??= this.writeFailure(); }
  private async writeFailure(): Promise<void> {
    try {
      this.writeFixed(`SCRIBE_STORE_BOOTSTRAP:${this.stage}\n`);
      if (this.bridgeReason !== undefined) this.writeFixed(`SCRIBE_STORE_BRIDGE:${this.bridgeReason}\n`);
      if (this.bridgeExit !== undefined) this.writeFixed(`SCRIBE_STORE_BRIDGE_EXIT:${this.bridgeExit}\n`);
      if (this.bridgeSignal !== undefined) this.writeFixed(`SCRIBE_STORE_BRIDGE_SIGNAL:${this.bridgeSignal}\n`);
    } catch { /* Diagnostics cannot block closure. */ }
    const directory = this.directory;
    if (!directory) return;
    try {
      if (!isAbsolute(directory) || await realpath(directory) !== directory) return;
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) return;
      const file = await open(join(directory, "store-bootstrap-diagnostics-v1.jsonl"),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const info = await file.stat();
        const line = JSON.stringify({ event: "store_bootstrap_failed", pid: process.pid, reason_code: this.stage,
          ...(this.bridgeReason === undefined ? {} : { bridge_reason_code: this.bridgeReason }),
          ...(this.bridgeExit === undefined ? {} : { bridge_exit_code: this.bridgeExit }),
          ...(this.bridgeSignal === undefined ? {} : { bridge_signal_code: this.bridgeSignal }) }) + "\n";
        if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0
          || info.size + Buffer.byteLength(line) > 4096) return;
        await file.writeFile(line);
      } finally { await file.close(); }
    } catch { /* Keep the fixed stderr marker when the private journal cannot be opened. */ }
  }
}

/** A rejected native acquisition has already honored its cleanup contract.
 * Persist its fixed diagnostics before exposing rejection to host quit cleanup. */
export async function recordRejectedStoreAcquisition<T>(diagnostics: StoreBootstrapDiagnostics,
  acquire: () => Promise<T>): Promise<T> {
  try { return await acquire(); }
  catch (error) { await diagnostics.failed(); throw error; }
}

/** The bridge owns this one closed line grammar; arbitrary stderr is discarded. */
export class StoreBridgeDiagnosticDecoder {
  private pending = "";
  private remaining = 16;
  private bytes = 0;
  constructor(private readonly accept: (reason: number) => void) {}
  push(bytes: Uint8Array): void {
    if (this.bytes + bytes.byteLength > 1024 || bytes.some(value => value > 127)) {
      this.remaining = 0; this.pending = ""; return;
    }
    this.bytes += bytes.byteLength;
    this.pending += Buffer.from(bytes).toString("ascii");
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
      const match = /^SCRIBE_STORE_BRIDGE:([1-9]|1[0-2])$/u.exec(line);
      if (match && this.remaining-- > 0) this.accept(Number(match[1]));
    }
  }
}
