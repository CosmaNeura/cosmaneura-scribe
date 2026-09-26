import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_FRAME_BYTES } from "../../review-ui/src/capture-response-limits";
import { NativeProviderFrameDecoder } from "./native-provider-frames.js";

describe("bounded native provider response frames", () => {
  it("retains split Unicode and dispatches every complete frame while wiping owned bytes", () => {
    const decoder = new NativeProviderFrameDecoder(), received: string[] = [], borrowed: Buffer[] = [];
    const original = Buffer.from('{"text":"🧪"}\n{"next":true}\n');
    for (const byte of original) {
      const input = Buffer.from([byte]);
      decoder.push(input, frame => { received.push(frame.toString()); borrowed.push(frame); });
      expect(input[0]).toBe(0);
    }
    expect(received).toEqual(['{"text":"🧪"}', '{"next":true}']);
    expect(borrowed.every(frame => frame.every(byte => byte === 0))).toBe(true);
  });
  it("consumes a large fragmented response and releases it before a following small frame", () => {
    const decoder = new NativeProviderFrameDecoder(), size = 32 * 1024 * 1024 + 8192;
    const lengths: number[] = [], borrowed: Buffer[] = [];
    const receive = (frame: Buffer): void => { lengths.push(frame.length); borrowed.push(frame); };
    for (let written = 0; written < size; written += 4096) decoder.push(Buffer.alloc(4096, 120), receive);
    decoder.push(Buffer.from("\n{}\n"), receive);
    expect(lengths).toEqual([size, 2]);
    expect(borrowed.every(frame => frame.every(byte => byte === 0))).toBe(true);
  });
  it("allows the exact frame boundary and rejects one excess byte before delivery", () => {
    for (const excess of [0, 1]) {
      const decoder = new NativeProviderFrameDecoder(); let delivered = 0;
      const receive = (frame: Buffer): void => { delivered = frame.length; };
      for (let written = 0; written < MAX_PROVIDER_FRAME_BYTES; written += 65_536) {
        decoder.push(Buffer.alloc(Math.min(65_536, MAX_PROVIDER_FRAME_BYTES - written), 120), receive);
      }
      if (excess) {
        const input = Buffer.from("x\n");
        expect(() => decoder.push(input, receive)).toThrow("provider_native_unavailable");
        expect(input.every(byte => byte === 0)).toBe(true);
        expect(delivered).toBe(0);
        expect(() => decoder.push(Buffer.from("{}\n"), receive)).toThrow();
      } else {
        decoder.push(Buffer.from("\n"), receive); expect(delivered).toBe(MAX_PROVIDER_FRAME_BYTES);
      }
    }
  });
  it("clears a partial reply and stops dispatch after closure or a parser failure", () => {
    for (const fail of [false, true]) {
      const decoder = new NativeProviderFrameDecoder(); let calls = 0;
      const input = Buffer.from("first\nsecond\n"); let borrowed: Buffer | undefined;
      const run = (): void => decoder.push(input, frame => {
        calls++; borrowed = frame;
        if (fail) throw new Error("synthetic-parser-failure");
        decoder.clear();
      });
      if (fail) expect(run).toThrow("provider_native_unavailable"); else run();
      expect(calls).toBe(1);
      expect(borrowed?.every(byte => byte === 0)).toBe(true);
      expect(input.every(byte => byte === 0)).toBe(true);
      expect(() => decoder.push(Buffer.from("more"), () => undefined)).toThrow();
    }
  });
});
