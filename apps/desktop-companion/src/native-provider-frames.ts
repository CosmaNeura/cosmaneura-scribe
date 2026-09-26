import { MAX_PROVIDER_FRAME_BYTES } from "../../review-ui/src/capture-response-limits";

/** Native newline frames. Reuse the audio decoder's synchronous ownership and
 * wiping pattern, growing geometrically instead of recopying every pipe read. */
export class NativeProviderFrameDecoder {
  private bytes = Buffer.alloc(0);
  private used = 0;
  private invalid = false;

  push(input: Buffer, receive: (payload: Buffer) => void): void {
    try {
      if (this.invalid) throw failure();
      let offset = 0;
      while (offset < input.length) {
        const newline = input.indexOf(10, offset), end = newline < 0 ? input.length : newline;
        const needed = this.used + end - offset;
        if (needed > MAX_PROVIDER_FRAME_BYTES) throw failure();
        if (needed > this.bytes.length) {
          const next = Buffer.alloc(Math.min(MAX_PROVIDER_FRAME_BYTES,
            Math.max(65_536, this.bytes.length * 2, needed)));
          this.bytes.copy(next, 0, 0, this.used); this.bytes.fill(0); this.bytes = next;
        }
        input.copy(this.bytes, this.used, offset, end); this.used = needed;
        if (newline < 0) return;
        if (this.used === 0) throw failure();
        receive(this.bytes.subarray(0, this.used));
        if (this.invalid) return;
        this.bytes.fill(0); this.used = 0;
        if (this.bytes.length > 65_536) this.bytes = Buffer.alloc(0);
        offset = end + 1;
      }
    } catch { this.clear(); throw failure(); }
    finally { input.fill(0); }
  }
  clear(): void {
    this.invalid = true; this.bytes.fill(0); this.bytes = Buffer.alloc(0); this.used = 0;
  }
}
function failure(): Error { return new Error("provider_native_unavailable"); }
