import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import type { DesktopPCMCoverage, DesktopPCMStart } from "./native-pcm-driver.js";
import { parseDesktopPCMStart, parseDesktopPCMCompletion } from "./pcm-capture-source.js";
import { type DesktopRecordNamespace, failure, uuid } from "./durable-record-store.js";

/** Reuses the existing provider and review journals in trusted main code. This
 * adapter is not registered as a Capacitor plugin or exposed to renderer IPC. */
export function desktopJournalRecords(records: DesktopRecordNamespace): Pick<SecureQueuePlugin, "get" | "create" | "compareAndSwap"> {
  const save = async (key: string, previous: number | null, data: string): Promise<{ revision: string }> => {
    if (typeof data !== "string" || data.length > 2_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) throw failure();
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    try { return { revision: String(await records.save(key, previous, bytes)) }; }
    finally { bytes.fill(0); }
  };
  return {
    get: async ({ key }) => {
      const value = await records.get(key);
      if (!value) throw Object.assign(failure(), { code: "SECURE_QUEUE_NOT_FOUND" });
      try { return { key: value.key, revision: String(value.revision), data: Buffer.from(value.data).toString("base64") }; }
      finally { value.data.fill(0); }
    },
    create: ({ key, data }) => save(key, null, data),
    compareAndSwap: ({ key, data, expectedRevision }) => {
      if (!/^[1-9][0-9]{0,15}$/u.test(expectedRevision) || !Number.isSafeInteger(Number(expectedRevision))) throw failure();
      return save(key, Number(expectedRevision), data);
    },
  };
}

/** One recording attempt has one immutable start and at most one completion.
 * An absent completion survives reopening as explicitly incomplete coverage. */
export class DurableDesktopCoverage {
  constructor(private readonly records: DesktopRecordNamespace, private readonly attemptId: string) { uuid(attemptId); }
  readonly persist = async (coverage: DesktopPCMCoverage): Promise<void> => {
    coverage = structuredClone(coverage);
    if (!coverage || Object.keys(coverage).sort().join(",") !== "phase,value"
      || coverage.phase !== "started" && coverage.phase !== "stopped") throw failure();
    const prior = await this.read();
    const last = prior?.intervals?.at(-1);
    const previous = last ? last.coverage : prior?.value;
    if (coverage.phase === "started") {
      const start = parseDesktopPCMStart(coverage.value);
      if (previous && JSON.stringify(previous) !== JSON.stringify({ phase: "started", value: start })) throw failure();
      if (previous) return;
    } else {
      if (!previous) throw failure();
      const start = previous.phase === "started" ? previous.value : previous.value.start;
      parseDesktopPCMCompletion(coverage.value, start, coverage.value.outputFrames);
      if (previous.phase === "stopped") {
        if (JSON.stringify(previous) !== JSON.stringify(coverage)) throw failure();
        return;
      }
    }
    const value = prior?.intervals ? { schemaVersion: 2, intervals: prior.intervals.map((item, index) =>
      index === prior.intervals!.length - 1 ? { ...item, coverage } : item) } : coverage;
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    try { await this.records.save(uuid(this.attemptId), prior?.revision ?? null, bytes); }
    finally { bytes.fill(0); }
  };
  async load(): Promise<DesktopPCMCoverage | null> {
    const prior = await this.read();
    return prior?.intervals ? prior.intervals.at(-1)!.coverage : prior?.value ?? null;
  }
  /** Called after confirmed physical/server stop, before a fresh source start.
   * Receipt ID makes retries exact even for a zero-chunk interval. */
  async beginInterval(receiptId: string, firstSequenceNumber: number): Promise<void> {
    uuid(receiptId);
    if (!Number.isSafeInteger(firstSequenceNumber) || firstSequenceNumber < 0 || firstSequenceNumber > 999) throw failure();
    const prior = await this.read();
    const intervals: CoverageInterval[] = prior?.intervals ?? [
      { receiptId: this.attemptId, firstSequenceNumber: 0, coverage: prior?.value ?? null }];
    const existing = intervals.find(item => item.receiptId === receiptId);
    if (existing) {
      if (intervals.at(-1) !== existing || existing.firstSequenceNumber !== firstSequenceNumber) throw failure();
      return;
    }
    if (intervals.length >= 1000 || firstSequenceNumber < intervals.at(-1)!.firstSequenceNumber) throw failure();
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2,
      intervals: [...intervals, { receiptId, firstSequenceNumber, coverage: null }] }));
    try { await this.records.save(uuid(this.attemptId), prior?.revision ?? null, bytes); }
    finally { bytes.fill(0); }
  }
  private async read(): Promise<{ value: DesktopPCMCoverage | null; intervals?: CoverageInterval[]; revision: number } | null> {
    const record = await this.records.get(uuid(this.attemptId));
    if (!record) return null;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.data));
      if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 2) {
        if (Object.keys(value).sort().join(",") !== "intervals,schemaVersion" || !("intervals" in value)
          || !Array.isArray(value.intervals) || value.intervals.length < 2 || value.intervals.length > 1000) throw failure();
        const seen = new Set<string>(); let first = 0;
        for (const item of value.intervals as CoverageInterval[]) {
          if (!item || Object.keys(item).sort().join(",") !== "coverage,firstSequenceNumber,receiptId"
            || !Number.isSafeInteger(item.firstSequenceNumber) || item.firstSequenceNumber < first
            || item.firstSequenceNumber > 999 || seen.size === 0 && item.firstSequenceNumber !== 0
            || seen.has(uuid(item.receiptId))) throw failure();
          if (item.coverage !== null) validateCoverage(item.coverage);
          seen.add(item.receiptId); first = item.firstSequenceNumber;
        }
        return { value: null, intervals: value.intervals as CoverageInterval[], revision: record.revision };
      }
      validateCoverage(value);
      return { value, revision: record.revision };
    } finally { record.data.fill(0); }
  }
}

interface CoverageInterval { readonly receiptId: string; readonly firstSequenceNumber: number; readonly coverage: DesktopPCMCoverage | null }
function validateCoverage(value: unknown): asserts value is DesktopPCMCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "phase,value") throw failure();
  const coverage = value as DesktopPCMCoverage;
  if (coverage.phase === "started") parseDesktopPCMStart(coverage.value);
  else if (coverage.phase === "stopped") {
    const start: DesktopPCMStart = parseDesktopPCMStart(coverage.value.start);
    parseDesktopPCMCompletion(coverage.value, start, coverage.value.outputFrames);
  } else throw failure();
}
