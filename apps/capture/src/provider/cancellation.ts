import { isUuid } from "../../../review-ui/src/contracts";
import { record } from "./core-client";
import type { CreationRecords } from "./encounter-setup";
import type { ProviderSessionState } from "./native-plugin";

const base = ["contract_version", "action", "request_nonce", "grace_days", "phi_scope", "scope", "shared_login_preserved", "resource_manifest_status"];
const receiptFields = [...base, "operation_id", "received_at", "export_until", "access_fence_confirmed", "erasure_confirmed", "phase"];
export interface CancellationPreview {
  contract_version: "1"; action: "preview"; request_nonce: string; preview_sha256: string;
  grace_days: number; phi_scope: "core-and-scribe-clinical-records"; scope: "scribe-only";
  shared_login_preserved: true; resource_manifest_status: "unresolved";
}
export interface CancellationReceipt extends Omit<CancellationPreview, "action" | "preview_sha256"> {
  action: "request" | "status"; operation_id: string; received_at: string; export_until: string;
  access_fence_confirmed: true; erasure_confirmed: false; phase: "read-only-export" | "read-only-expired";
}
export interface ScribeCancellation {
  load(signal: AbortSignal): Promise<CancellationPreview | CancellationReceipt>;
  submit(preview: CancellationPreview, signal: AbortSignal): Promise<CancellationReceipt>;
}
const fail = (): Error => new Error("scribe_cancellation_unconfirmed");
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!record(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw fail();
  return value;
};
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const stamp = (value: unknown): value is string => typeof value === "string" && value.length <= 40
  && /(?:Z|\+00:00)$/u.test(value) && Number.isFinite(Date.parse(value));
export function parseCancellation(value: unknown, nonce?: string): CancellationPreview | CancellationReceipt {
  if (!record(value)) throw fail();
  const preview = value.action === "preview";
  exact(value, preview ? [...base, "preview_sha256"] : receiptFields);
  if (value.contract_version !== "1" || !isUuid(value.request_nonce) || nonce !== undefined && value.request_nonce !== nonce
    || value.scope !== "scribe-only" || value.shared_login_preserved !== true || value.resource_manifest_status !== "unresolved"
    || value.phi_scope !== "core-and-scribe-clinical-records" || !Number.isInteger(value.grace_days)
    || (value.grace_days as number) < 30 || (value.grace_days as number) > 90) throw fail();
  if (preview) {
    if (!digest(value.preview_sha256)) throw fail();
  } else if (!["request", "status"].includes(String(value.action)) || !isUuid(value.operation_id)
    || !stamp(value.received_at) || !stamp(value.export_until) || Date.parse(value.export_until) <= Date.parse(value.received_at)
    || value.access_fence_confirmed !== true || value.erasure_confirmed !== false
    || !["read-only-export", "read-only-expired"].includes(String(value.phase))) throw fail();
  return structuredClone(value) as unknown as CancellationPreview | CancellationReceipt;
}

type Pending = { key: string; preview: CancellationPreview };
type Saved = { version: 1; account: string; pending: Pending | null; receipt: CancellationReceipt | null };
/** Verified native account owns an encrypted retry record. No identity, URL,
 * token or idempotency key is selected by the UI. Shared sign-in is retained. */
export function createScribeCancellation(options: {
  state(): Promise<ProviderSessionState>;
  records(account: string, signal: AbortSignal): Promise<{ records: CreationRecords; close(): Promise<void> }>;
  send(body: Record<string, unknown>, key: string, state: ProviderSessionState, signal: AbortSignal): Promise<Response>;
}): ScribeCancellation {
  let running = false;
  const run = async <T>(signal: AbortSignal, operation: (state: ProviderSessionState, account: string,
    records: CreationRecords, saved: Saved, revision: string | null, check: () => Promise<void>) => Promise<T>): Promise<T> => {
    if (running || signal.aborted) throw fail(); running = true;
    let opened: Awaited<ReturnType<typeof options.records>> | undefined;
    try {
      const state = await options.state(), account = state.accountIdentitySHA256;
      if (state.phase !== "ready" || !isUuid(state.revision) || !digest(account) || signal.aborted) throw fail();
      const check = async (): Promise<void> => {
        const next = await options.state();
        if (signal.aborted || next.phase !== "ready" || next.revision !== state.revision || next.accountIdentitySHA256 !== account) throw fail();
      };
      opened = await options.records(account, signal); await check();
      const key = "scribe-cancellation-v1:" + account;
      let saved: Saved = { version: 1, account, pending: null, receipt: null }, revision: string | null = null;
      try {
        const item = await opened.records.get({ key }); await check();
        if (item.key !== key || !/^[1-9][0-9]*$/u.test(item.revision) || item.data.length > 8192) throw fail();
        const value = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(item.data), ch => ch.charCodeAt(0)))), ["version", "account", "pending", "receipt"]);
        if (value.version !== 1 || value.account !== account) throw fail();
        const pending = value.pending === null ? null : exact(value.pending, ["key", "preview"]);
        if (pending && (!isUuid(pending.key) || parseCancellation(pending.preview).action !== "preview")) throw fail();
        const receipt = value.receipt === null ? null : parseCancellation(value.receipt);
        if (receipt?.action === "preview") throw fail();
        saved = { version: 1, account, pending: pending as Pending | null, receipt }; revision = item.revision;
      } catch (error) {
        if (!record(error) || error.code !== "SECURE_QUEUE_NOT_FOUND") throw error;
      }
      return await operation(state, account, opened.records, saved, revision, check);
    } finally { await opened?.close(); running = false; }
  };
  const save = async (records: CreationRecords, saved: Saved, revision: string | null): Promise<void> => {
    const key = "scribe-cancellation-v1:" + saved.account;
    const data = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(saved))));
    if (revision === null) await records.create({ key, data });
    else await records.compareAndSwap({ key, expectedRevision: revision, data });
  };
  const request = async (body: Record<string, unknown>, key: string, state: ProviderSessionState, signal: AbortSignal) => {
    const nonce = crypto.randomUUID(), response = await options.send({ ...body, request_nonce: nonce }, key, state, signal);
    if (response.status === 404 && body.action === "status") return null;
    if (response.status !== 200) throw fail();
    return parseCancellation(await response.json(), nonce);
  };
  return {
    load: signal => run(signal, async (state, _account, records, saved, revision, check) => {
      const status = await request({ action: "status", ...(saved.receipt ? { operation_id: saved.receipt.operation_id } : {}) }, crypto.randomUUID(), state, signal);
      await check();
      if (status) {
        if (status.action === "preview") throw fail();
        await save(records, { ...saved, pending: null, receipt: status }, revision); await check(); return status;
      }
      if (saved.receipt) throw fail(); // Never treat a lost server receipt as a new cancellation.
      if (saved.pending) {
        const result = await request({ action: "request", preview_sha256: saved.pending.preview.preview_sha256,
          confirmation: "CANCEL" }, saved.pending.key, state, signal); await check();
        if (!result || result.action === "preview") throw fail();
        await save(records, { ...saved, pending: null, receipt: result }, revision); await check(); return result;
      }
      const preview = await request({ action: "preview" }, crypto.randomUUID(), state, signal); await check();
      if (!preview || preview.action !== "preview") throw fail(); return preview;
    }),
    submit: (preview, signal) => run(signal, async (state, _account, records, saved, revision, check) => {
      if (parseCancellation(preview).action !== "preview") throw fail();
      // Before any retry, discover the server's own receipt. This also recovers
      // after reinstall or loss of local encrypted metadata.
      const status = await request({ action: "status" }, crypto.randomUUID(), state, signal); await check();
      if (status) {
        if (status.action === "preview") throw fail();
        await save(records, { ...saved, pending: null, receipt: status }, revision); await check(); return status;
      }
      const pending = saved.pending ?? { key: crypto.randomUUID(), preview };
      if (pending.preview.preview_sha256 !== preview.preview_sha256) throw fail();
      if (!saved.pending) {
        await save(records, { ...saved, pending }, revision); await check();
        const retained = await records.get({ key: "scribe-cancellation-v1:" + saved.account }); revision = retained.revision;
      }
      const result = await request({ action: "request", preview_sha256: pending.preview.preview_sha256, confirmation: "CANCEL" }, pending.key, state, signal);
      await check(); if (!result || result.action === "preview") throw fail();
      await save(records, { ...saved, pending: null, receipt: result }, revision); await check(); return result;
    }),
  };
}
