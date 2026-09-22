/** Private inherited-pipe framing. One fixed buffer; no accumulated stream or
 * audio strings. The receiver must consume/copy a frame synchronously. */
export class NativeProcessDecoder {
  private readonly bytes = Buffer.alloc(8201);
  private used = 0;
  private target = 4;
  private invalid = false;

  push(input: Buffer, receive: (kind: number, payload: Buffer) => void): void {
    try {
      if (this.invalid) throw new Error("desktop_pipe_invalid");
      let offset = 0;
      while (offset < input.length) {
        const count = Math.min(this.target - this.used, input.length - offset);
        input.copy(this.bytes, this.used, offset, offset + count);
        offset += count; this.used += count;
        if (this.used !== this.target) continue;
        if (this.target === 4) {
          const length = this.bytes.readUInt32BE(0);
          if (length < 2 || length > 8197) throw new Error("desktop_pipe_invalid");
          this.target = length + 4;
        } else {
          const kind = this.bytes[4];
          if (kind !== 1 && kind !== 2 || kind === 1 && this.target > 2052
            || kind === 2 && (this.target < 11 || (this.target - 9) % 2 !== 0)) {
            throw new Error("desktop_pipe_invalid");
          }
          receive(kind, this.bytes.subarray(5, this.target));
          this.bytes.fill(0); this.used = 0; this.target = 4;
        }
      }
    } catch { this.clear(); throw new Error("desktop_pipe_invalid"); }
    finally { input.fill(0); }
  }
  finish(): void {
    const partial = this.used !== 0;
    this.clear();
    if (partial) throw new Error("desktop_pipe_truncated");
  }
  clear(): void { this.invalid = true; this.bytes.fill(0); this.used = 0; }
}

export function nativeCommand(value: Readonly<Record<string, unknown>>): Buffer {
  const data = Buffer.from(JSON.stringify(value), "utf8");
  if (data.length < 1 || data.length > 2047) throw new Error("desktop_pipe_invalid");
  const frame = Buffer.alloc(data.length + 5);
  frame.writeUInt32BE(data.length + 1); frame[4] = 1; data.copy(frame, 5);
  return frame;
}

export function nativeMetadata(payload: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("desktop_pipe_invalid");
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
