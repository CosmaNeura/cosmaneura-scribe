import { expect, it } from "vitest";
import { createReadinessNativeModel } from "./desktop-readiness-native-model.mjs";

async function fixture(model = "modern-clean", options = {}) {
    const abort = new AbortController(), sessionId = crypto.randomUUID();
    const prepared = { sessionId, captureLeaseId: crypto.randomUUID(), leaseReceiptId: crypto.randomUUID(),
        captureLeaseGeneration: 1, captureAuthorizedUntil: new Date(Date.now() + 60_000).toISOString() };
    const owner = await createReadinessNativeModel({ model, sessionId, consentRecordId: crypto.randomUUID(),
        signal: abort.signal, apiMs: 0, timed: async (_label, _delay, fn) => fn(), ...options });
    return { ...owner, abort, prepared,
        remote: () => owner.events.filter(event => event.boundary === "simulated-remote").map(event => event.operation) };
}

it("consumes the combined decision once and uses the real backend's no-op after confirmed retirement", async () => {
    const f = await fixture();
    try {
        expect(() => f.assertNativeStartAllowed()).toThrow();
        const { grant } = await f.mount.authorizeRecorder(f.prepared, f.abort.signal);
        expect(() => f.assertNativeStartAllowed()).toThrow();
        await f.mount.authority.authorizeStart(grant, f.abort.signal);
        f.assertNativeStartAllowed();
        expect(() => f.assertNativeStartAllowed()).toThrow();
        await expect(f.mount.authority.authorizeStart(grant, f.abort.signal)).rejects.toThrow();
        expect(f.remote()).toEqual(["sourcePrepareAndAuthorize"]);
        await f.retireSource(); expect(f.ownerCount()).toBe(0);
        await f.retireSource();
        expect(f.remote()).toEqual(["sourcePrepareAndAuthorize", "sourceStopped"]);
        expect(f.events.at(-1).boundary).toBe("no-op");
        await expect(f.mount.authority.authorizeStart(grant, f.abort.signal)).rejects.toThrow();
    } finally { await f.close(); }
});

it("retains and retries the same real backend owner after a lost stop reply", async () => {
    const ids = [];
    const f = await fixture("modern-interrupted", { beforeStop: async (_method, payload) => {
        ids.push(payload.sourceLeaseId);
        if (ids.length === 1) throw new Error("lost synthetic stop reply");
    } });
    try {
        await f.mount.authorizeRecorder(f.prepared, f.abort.signal);
        await expect(f.retireSource()).rejects.toThrow("lost synthetic stop reply");
        expect(f.ownerCount()).toBe(1);
        await f.retireSource();
        expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
        expect(f.ownerCount()).toBe(0);
        await f.mount.authorizeRecorder(f.prepared, f.abort.signal);
        expect(f.ownerCount()).toBe(1);
    } finally { await f.close(); }
});

it("models legacy known-404 fallback and a separate remote authorization", async () => {
    const f = await fixture("legacy-clean");
    try {
        const { grant } = await f.mount.authorizeRecorder(f.prepared, f.abort.signal);
        expect(f.remote()).toEqual(["sourceCombinedUnsupported404", "sourcePrepare"]);
        expect(() => f.assertNativeStartAllowed()).toThrow();
        await f.mount.authority.authorizeStart(grant, f.abort.signal);
        expect(f.remote()).toEqual(["sourceCombinedUnsupported404", "sourcePrepare", "sourceAuthorize"]);
        f.assertNativeStartAllowed();
    } finally { await f.close(); }
});

it("withholds expired local authority and simulated native start", async () => {
    let now = Date.now();
    const f = await fixture("modern-clean", { now: () => now });
    try {
        const { grant } = await f.mount.authorizeRecorder(f.prepared, f.abort.signal);
        now += 15_001;
        await expect(f.mount.authority.authorizeStart(grant, f.abort.signal)).rejects.toThrow();
        expect(() => f.assertNativeStartAllowed()).toThrow();
        expect(f.remote()).toEqual(["sourcePrepareAndAuthorize"]);
    } finally { await f.close(); }
});

it("retains a late cancelled preparation for explicit cleanup without starting", async () => {
    const attempt = new AbortController();
    const f = await fixture("modern-clean", { timed: async (_label, _delay, fn) => {
        const result = await fn(); attempt.abort(); return result;
    } });
    try {
        await expect(f.mount.authorizeRecorder(f.prepared, attempt.signal)).rejects.toThrow();
        expect(f.ownerCount()).toBe(1); expect(() => f.assertNativeStartAllowed()).toThrow();
        await f.retireSource();
        expect(f.remote()).toEqual(["sourcePrepareAndAuthorize", "sourcePreparationRelease"]);
        expect(f.ownerCount()).toBe(0);
    } finally { await f.close(); }
});
