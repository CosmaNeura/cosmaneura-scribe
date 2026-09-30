import { describe, expect, it } from "vitest";
import { parsePendingCreatorEdit } from "./creator-edit";
import { NativeCreatorEditJournal } from "./native-edit-journal";
import type { SecureQueueCompareAndSwapOptions, SecureQueueRecord } from "@cosmaneura-scribe/capacitor-secure-queue";

const scope = "00000000-0000-4000-8000-000000000001";
const session = "00000000-0000-4000-8000-000000000002";
const operation = {
  key: "review-stable-key",
  request: { schema_version: "1.0" as const, expected_source_transcript_version: 1,
    expected_working_transcript_id: scope, expected_working_transcript_version: 1,
    corrections: [{ source_segment_id: session, expected_source_segment_version: 1, content: "Sí, synthetic — no fever. 🩺" }],
    speakers: [{ speaker_id: scope, role: "clinician" as const, display_name: "Synthetic Provider", detail: null }] },
};

class NativeStoreFixture {
  readonly records = new Map<string, { data: string; revision: string }>();
  loseWriteReply = false;
  async get({ key }: { key: string }) {
    const value = this.records.get(key);
    if (!value) throw Object.assign(new Error("missing"), { code: "SECURE_QUEUE_NOT_FOUND" });
    return { key, ...value };
  }
  async create(value: SecureQueueRecord) {
    if (this.records.has(value.key)) throw new Error("conflict");
    return this.write(value, "1");
  }
  async compareAndSwap(value: SecureQueueCompareAndSwapOptions) {
    const current = await this.get(value);
    if (current.revision !== value.expectedRevision) throw new Error("conflict");
    return this.write(value, String(Number(current.revision) + 1));
  }
  private write(value: SecureQueueRecord, revision: string) {
    this.records.set(value.key, { data: value.data, revision });
    if (this.loseWriteReply) { this.loseWriteReply = false; throw new Error("unconfirmed"); }
    return { revision };
  }
}

describe("creator correction recovery using native encrypted-store operations", () => {
  it("recovers a lost journal write through a new instance, retaining the exact request", async () => {
    const storage = new NativeStoreFixture();
    storage.loseWriteReply = true;
    const first = new NativeCreatorEditJournal(storage, scope, session);
    await expect(first.save(operation)).rejects.toThrow();
    const second = new NativeCreatorEditJournal(storage, scope, session);
    expect(await second.load()).toEqual(operation);
    await second.save(operation);
    await expect(second.save({ ...operation, request: { ...operation.request, expected_working_transcript_version: 2 } })).rejects.toThrow();
    await expect(second.clear("wrong-key")).rejects.toThrow();
    await second.clear(operation.key);
    expect(await second.load()).toBeNull();
  });

  it("isolates recovery scopes and refuses a moved record or extra protected fields", async () => {
    const storage = new NativeStoreFixture();
    const first = new NativeCreatorEditJournal(storage, scope, session);
    await first.save(operation);
    const second = new NativeCreatorEditJournal(storage, session, scope);
    expect(await second.load()).toBeNull();
    const [key, value] = [...storage.records.entries()][0]!;
    storage.records.set(key.replace(`${scope}:${session}`, `${session}:${scope}`), value);
    await expect(second.load()).rejects.toThrow();
    expect(() => parsePendingCreatorEdit({ ...operation, transcript: "protected" })).toThrow();
    expect(() => parsePendingCreatorEdit({ ...operation, request: { ...operation.request, creator: "other" } })).toThrow();
  });

  it("does not erase a newer decision after a competing writer wins", async () => {
    const storage = new NativeStoreFixture();
    const journal = new NativeCreatorEditJournal(storage, scope, session);
    const results = await Promise.allSettled([
      journal.save(operation), journal.save({ ...operation, key: "review-different-key" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await journal.load()).toEqual(operation);
    await journal.clear(operation.key);
    await journal.save({ ...operation, key: "review-next-decision" });
    await expect(journal.clear(operation.key)).rejects.toThrow();
    expect((await journal.load())?.key).toBe("review-next-decision");
  });
});
