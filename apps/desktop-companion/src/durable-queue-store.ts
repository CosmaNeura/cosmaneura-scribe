import { assertSafeCaptureRecord, cloneCaptureRecord } from "../../capture/src/queue/records";
import type { CaptureChunkRecord, CaptureQueueStorage, ReservedChunkRecord } from "../../capture/src/queue/types";
import { decodeCaptureRecord, encodeCaptureRecord } from "../../capture/src/storage/record-codec";
import { type DesktopRecordNamespace, type DesktopStoredRecord, failure, uuid } from "./durable-record-store.js";

/** One authorized session's existing queue format, sealed again for local storage. */
export class DurableDesktopQueueStorage implements CaptureQueueStorage {
  constructor(private readonly records: DesktopRecordNamespace, private readonly sessionId: string) { uuid(sessionId); }
  async create(record: ReservedChunkRecord): Promise<boolean> {
    this.check(record);
    if (record.state !== "reserved" || record.revision !== 1) throw failure();
    return this.save(record, null);
  }
  async get(objectId: string): Promise<CaptureChunkRecord | null> {
    const record = await this.records.get(uuid(objectId));
    return record ? this.decode(record) : null;
  }
  async list(): Promise<readonly CaptureChunkRecord[]> {
    const records = await this.records.list();
    try { return records.map(record => this.decode(record)).sort((a, b) => a.reservation.sequenceNumber - b.reservation.sequenceNumber); }
    finally { records.forEach(record => record.data.fill(0)); }
  }
  async compareAndSwap(objectId: string, expectedRevision: number, replacement: CaptureChunkRecord): Promise<boolean> {
    replacement = cloneCaptureRecord(replacement);
    this.check(replacement);
    if (uuid(replacement.reservation.objectId) !== uuid(objectId) || replacement.revision !== expectedRevision + 1) throw failure();
    const stored = await this.records.get(uuid(objectId));
    if (!stored) return false;
    if (this.decode(stored).revision !== expectedRevision) return false;
    return this.save(replacement, stored.revision);
  }
  private async save(record: CaptureChunkRecord, previous: number | null): Promise<boolean> {
    const bytes = new TextEncoder().encode(encodeCaptureRecord(record));
    try { await this.records.save(uuid(record.reservation.objectId), previous, bytes); return true; }
    catch (error) { if (error instanceof Error && error.message === "desktop_storage_conflict") return false; throw failure(); }
    finally { bytes.fill(0); }
  }
  private decode(stored: DesktopStoredRecord): CaptureChunkRecord {
    try {
      const record = decodeCaptureRecord(new TextDecoder("utf-8", { fatal: true }).decode(stored.data));
      this.check(record);
      if (uuid(record.reservation.objectId) !== stored.key || record.revision !== stored.revision) throw failure();
      return record;
    } finally { stored.data.fill(0); }
  }
  private check(record: CaptureChunkRecord): void {
    assertSafeCaptureRecord(record);
    if (uuid(record.reservation.sessionId) !== uuid(this.sessionId)) throw failure();
  }
}
