import { describe, expect, it } from "vitest";
import { createScribeCancellation, parseCancellation, type CancellationPreview } from "./cancellation";
import type { CreationRecords } from "./encounter-setup";

const account = "a".repeat(64), revision = "11111111-1111-4111-8111-111111111111";
const preview: CancellationPreview = { contract_version: "1", action: "preview", request_nonce: crypto.randomUUID(),
  preview_sha256: "b".repeat(64), grace_days: 90, phi_scope: "core-and-scribe-clinical-records", scope: "scribe-only",
  shared_login_preserved: true, resource_manifest_status: "unresolved" };
function receipt(action: "status" | "request", nonce: string) {
  const { preview_sha256: _digest, ...base } = preview;
  void _digest;
  return { ...base, action, request_nonce: nonce, operation_id: "22222222-2222-4222-8222-222222222222",
    received_at: "2026-11-02T12:00:00Z", export_until: "2027-01-31T12:00:00Z",
    access_fence_confirmed: true, erasure_confirmed: false, phase: "read-only-export" };
}
function records(): CreationRecords {
  let item: { key: string; data: string; revision: string } | null = null;
  return {
    get: async ({ key }) => {
      if (!item || item.key !== key) throw Object.assign(new Error("missing"), { code: "SECURE_QUEUE_NOT_FOUND" });
      return { ...item };
    },
    create: async ({ key, data }) => {
      if (item) throw new Error("conflict"); item = { key, data, revision: "1" }; return { revision: "1" };
    },
    compareAndSwap: async ({ key, data, expectedRevision }) => {
      if (!item || item.key !== key || item.revision !== expectedRevision) throw new Error("conflict");
      item = { key, data, revision: String(Number(item.revision) + 1) }; return { revision: item.revision };
    },
  };
}
describe("Scribe-only cancellation", () => {
  it("rejects shared-login deletion, false fences and mismatched nonces", () => {
    const value = receipt("status", preview.request_nonce);
    expect(() => parseCancellation({ ...value, shared_login_preserved: false })).toThrow();
    expect(() => parseCancellation({ ...value, access_fence_confirmed: false })).toThrow();
    expect(() => parseCancellation(value, crypto.randomUUID())).toThrow();
    expect(() => parseCancellation({ ...value, extra: "untrusted" })).toThrow();
  });
  it("checks own durable receipt before displaying a new confirmation", async () => {
    const seen: string[] = [];
    const client = createScribeCancellation({ state: async () => ({ phase: "ready", revision, accountIdentitySHA256: account }),
      records: async () => ({ records: records(), close: async () => undefined }),
      send: async body => { seen.push(String(body.action)); return Response.json(receipt("status", String(body.request_nonce))); } });
    expect((await client.load(new AbortController().signal)).action).toBe("status"); expect(seen).toEqual(["status"]);
  });
  it("retains the original request key and preview across a lost reply and restart", async () => {
    const durable = records(), keys: string[] = []; let fail = true;
    const options: Parameters<typeof createScribeCancellation>[0] = {
      state: async () => ({ phase: "ready", revision, accountIdentitySHA256: account }),
      records: async () => ({ records: durable, close: async () => undefined }),
      send: async (body, key) => {
        if (body.action === "status") return new Response("{}", { status: 404 });
        keys.push(key); expect(body.confirmation).toBe("CANCEL"); expect(body.preview_sha256).toBe(preview.preview_sha256);
        if (fail) { fail = false; throw new Error("lost response"); }
        return Response.json(receipt("request", String(body.request_nonce)));
      },
    };
    await expect(createScribeCancellation(options).submit(preview, new AbortController().signal)).rejects.toThrow();
    expect((await createScribeCancellation(options).load(new AbortController().signal)).action).toBe("request");
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  });
  it("recovers a server-committed cancellation after reinstall without submitting again", async () => {
    const seen: string[] = [];
    const client = createScribeCancellation({ state: async () => ({ phase: "ready", revision, accountIdentitySHA256: account }),
      records: async () => ({ records: records(), close: async () => undefined }),
      send: async body => { seen.push(String(body.action)); return Response.json(receipt("status", String(body.request_nonce))); } });
    await client.submit(preview, new AbortController().signal); expect(seen).toEqual(["status"]);
  });
  it("does not submit if durable intent persistence fails", async () => {
    let submitted = false; const durable = records(); durable.create = async () => { throw new Error("storage unavailable"); };
    const client = createScribeCancellation({ state: async () => ({ phase: "ready", revision, accountIdentitySHA256: account }),
      records: async () => ({ records: durable, close: async () => undefined }),
      send: async body => { if (body.action === "request") submitted = true; return new Response("{}", { status: 404 }); } });
    await expect(client.submit(preview, new AbortController().signal)).rejects.toThrow(); expect(submitted).toBe(false);
  });
  it("fences a switched account before request submission", async () => {
    let reads = 0, submitted = false;
    const client = createScribeCancellation({ state: async () => ({ phase: "ready", revision,
      accountIdentitySHA256: ++reads > 1 ? "c".repeat(64) : account }),
      records: async () => ({ records: records(), close: async () => undefined }),
      send: async () => { submitted = true; return Response.json({}); } });
    await expect(client.submit(preview, new AbortController().signal)).rejects.toThrow(); expect(submitted).toBe(false);
  });
});
