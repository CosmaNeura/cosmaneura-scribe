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
    if (coverage.phase === "started") {
      const start = parseDesktopPCMStart(coverage.value);
      if (prior && JSON.stringify(prior.value) !== JSON.stringify({ phase: "started", value: start })) throw failure();
      if (prior) return;
    } else {
      if (!prior) throw failure();
      const start = prior.value.phase === "started" ? prior.value.value : prior.value.value.start;
      parseDesktopPCMCompletion(coverage.value, start, coverage.value.outputFrames);
      if (prior.value.phase === "stopped") {
        if (JSON.stringify(prior.value) !== JSON.stringify(coverage)) throw failure();
        return;
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(coverage));
    try { await this.records.save(uuid(this.attemptId), prior?.revision ?? null, bytes); }
    finally { bytes.fill(0); }
  };
  async load(): Promise<DesktopPCMCoverage | null> { return (await this.read())?.value ?? null; }
  private async read(): Promise<{ value: DesktopPCMCoverage; revision: number } | null> {
    const record = await this.records.get(uuid(this.attemptId));
    if (!record) return null;
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.data)) as DesktopPCMCoverage;
      if (!value || Object.keys(value).sort().join(",") !== "phase,value") throw failure();
      if (value.phase === "started") parseDesktopPCMStart(value.value);
      else if (value.phase === "stopped") {
        const start: DesktopPCMStart = parseDesktopPCMStart(value.value.start);
        parseDesktopPCMCompletion(value.value, start, value.value.outputFrames);
      } else throw failure();
      return { value, revision: record.revision };
    } finally { record.data.fill(0); }
  }
}
