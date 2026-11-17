import { createHash } from "node:crypto";

export const STORE_BRIDGE_HASH_ALGORITHM = "macho-store-v1" as const;

/** Hash every executable/load-command byte before the final signature, except
 * the two lengths which Apple's distribution signing changes. No code, offset,
 * entitlement policy or runtime identity is inferred from the signature blob.
 * macOS loading and the existing private-service peer checks still validate it.
 */
export function storeBridgeMachoSha256(input: Uint8Array): string {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const need = (value: boolean): void => { if (!value) throw new Error("store_bridge_content_unavailable"); };
  need(bytes.length >= 32 && bytes.length <= 134_217_728);
  need(bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(12) === 2);
  // Current native Store builds are thin 64-bit arm64 or x86_64 executables.
  // A fat/32-bit image or a different CPU still requires a separate admission.
  const cpu = bytes.readUInt32LE(4), subtype = bytes.readUInt32LE(8);
  need(cpu === 0x0100000c && [0, 2].includes(subtype)
    || cpu === 0x01000007 && [3, 8].includes(subtype));
  const commands = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20);
  need(commands >= 1 && commands <= 512 && commandBytes >= 8 && commandBytes <= 1_048_576
    && 32 + commandBytes <= bytes.length);
  const integer = (offset: number): number => {
    const value = bytes.readBigUInt64LE(offset);
    need(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value);
  };
  const name = (offset: number): string => {
    const value = bytes.subarray(offset, offset + 16), zero = value.indexOf(0);
    const end = zero === -1 ? 16 : zero;
    need(value.subarray(0, end).every(byte => byte >= 32 && byte <= 126)
      && (zero === -1 || value.subarray(zero).every(byte => byte === 0)));
    return value.subarray(0, end).toString("ascii");
  };
  let signature: { command: number; offset: number; size: number } | undefined;
  let linkedit: { command: number; offset: number; size: number; vmSize: number } | undefined;
  const segments: { name: string; offset: number; size: number }[] = [];
  const sections: { offset: number; size: number }[] = [];
  let at = 32;
  for (let index = 0; index < commands; index++) {
    need(at + 8 <= 32 + commandBytes);
    const command = bytes.readUInt32LE(at), size = bytes.readUInt32LE(at + 4);
    need(size >= 8 && size % 8 === 0 && at + size <= 32 + commandBytes);
    if (command === 0x1d) { // LC_CODE_SIGNATURE
      need(signature === undefined && size === 16);
      signature = { command: at, offset: bytes.readUInt32LE(at + 8), size: bytes.readUInt32LE(at + 12) };
    } else if (command === 0x19) { // LC_SEGMENT_64
      need(size >= 72);
      const segment = name(at + 8), count = bytes.readUInt32LE(at + 64);
      need(count <= 128 && size === 72 + count * 80);
      const offset = integer(at + 40), length = integer(at + 48), vmSize = integer(at + 32);
      need(offset <= bytes.length && length <= bytes.length - offset && length <= vmSize);
      segments.push({ name: segment, offset, size: length });
      if (segment === "__LINKEDIT") {
        need(linkedit === undefined && count === 0);
        linkedit = { command: at, offset, size: length, vmSize };
      }
      for (let section = 0; section < count; section++) {
        const entry = at + 72 + section * 80, sectionSize = integer(entry + 40);
        const sectionOffset = bytes.readUInt32LE(entry + 48), type = bytes.readUInt32LE(entry + 64) & 0xff;
        need(name(entry + 16) === segment);
        if ([1, 12, 18].includes(type)) { need(sectionOffset === 0); continue; } // zero-fill only
        need(sectionOffset >= offset && sectionSize <= offset + length - sectionOffset
          && sectionOffset <= offset + length);
        sections.push({ offset: sectionOffset, size: sectionSize });
      }
    }
    at += size;
  }
  need(at === 32 + commandBytes && signature !== undefined && linkedit !== undefined);
  const sig = signature!, link = linkedit!;
  need(sig.offset % 16 === 0 && sig.offset >= at && sig.offset >= link.offset && sig.size >= 12
    && sig.size <= bytes.length - sig.offset && sig.offset + sig.size === bytes.length
    && link.offset + link.size === bytes.length && link.vmSize >= link.size);
  need(segments.filter(segment => segment.size > 0).every(segment => segment.name === "__LINKEDIT"
    || segment.offset + segment.size <= sig.offset));
  need(sections.every(section => section.offset + section.size <= sig.offset));
  // Validate the bounded embedded SuperBlob/index; its contents remain subject
  // to macOS signature/Team/entitlement checks when the same helper is loaded.
  need(bytes.readUInt32BE(sig.offset) === 0xfade0cc0);
  const blobSize = bytes.readUInt32BE(sig.offset + 4), count = bytes.readUInt32BE(sig.offset + 8);
  need(count >= 1 && count <= 64 && blobSize >= 12 + count * 8 && blobSize <= sig.size);
  const slots = new Set<number>(), blobs: { offset: number; size: number }[] = [];
  for (let index = 0; index < count; index++) {
    const entry = sig.offset + 12 + index * 8, slot = bytes.readUInt32BE(entry);
    const offset = bytes.readUInt32BE(entry + 4);
    need(!slots.has(slot) && offset >= 12 + count * 8 && offset <= blobSize - 8);
    slots.add(slot);
    const length = bytes.readUInt32BE(sig.offset + offset + 4);
    need(length >= 8 && length <= blobSize - offset);
    blobs.push({ offset, size: length });
  }
  blobs.sort((left, right) => left.offset - right.offset);
  need(blobs.every((blob, index) => index === 0 || blobs[index - 1]!.offset + blobs[index - 1]!.size <= blob.offset));
  const canonical = Buffer.from(bytes.subarray(0, sig.offset));
  try {
    canonical.writeUInt32LE(0, sig.command + 12);
    canonical.writeBigUInt64LE(0n, link.command + 48);
    return createHash("sha256").update(canonical).digest("hex");
  } finally { canonical.fill(0); }
}
