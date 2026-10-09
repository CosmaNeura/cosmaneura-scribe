import { connectDesktopNativeBackend } from "../src/native-provider-backend.js";

export const readinessModels = ["modern-clean", "modern-interrupted", "legacy-clean", "dependency-sensitivity"];

// The real backend owns source IDs and retirement. This boundary models the
// Swift owner's combined decision, not Swift execution or measured HTTP time.
export async function createReadinessNativeModel({ model, sessionId, consentRecordId, signal,
    timed, apiMs, now = Date.now, beforeStop = async () => undefined }) {
    const revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
    const suffix = "01j" + "0".repeat(23), appointmentRef = "appointment_" + suffix;
    const bindingRef = "scribe_capture_binding_" + suffix;
    const encounter = { appointmentRef, title: "Invented benchmark visit", detail: "No audio native boundary" };
    const owners = new Map(), events = [];
    let activeOwner;
    const event = (operation, boundary, injectedDelayMs = 0) => {
        const value = { operation, boundary, injected_delay_ms: injectedDelayMs };
        events.push(value);
        return value;
    };
    const remote = (operation, fn) => {
        event(operation, "simulated-remote", apiMs);
        return timed(`remote.${operation}`, apiMs, fn, "simulated-remote");
    };
    const decision = owner => {
        const expiresAt = new Date(Math.min(now() + 15_000, owner.deadline)).toISOString();
        return { schemaVersion: 1, decision: "authorized", ...owner.grant,
            issuedAt: new Date(now()).toISOString(), expiresAt,
            captureCapability: { capabilityId: crypto.randomUUID(), secret: "invented-benchmark-capability", expiresAt } };
    };
    const native = { signal, isReady: () => !signal.aborted,
        getState: async () => ({ phase: "ready", revision }),
        addListener: async () => ({ remove: async () => undefined }),
        request: async (method, payload, operationSignal) => {
            operationSignal?.throwIfAborted();
            if (method === "providerRequest") return { status: 200, body: JSON.stringify(payload.action === "catalog"
                ? { revision, encounters: [{ ...encounter, workspaceId }] }
                : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
            if (method === "sourcePrepareForStart") {
                if (activeOwner || payload.sessionId !== sessionId) throw new Error("Unexpected synthetic source owner");
                const owner = { grant: { captureSessionId: sessionId, actorId: "invented-creator", consentRecordId,
                    consentStatus: "granted", sessionStatus: "authorized", source: "desktop_companion", sourceLeaseId: crypto.randomUUID() },
                    deadline: Date.parse(payload.captureAuthorizedUntil), pending: null, consumed: false, nativeStarted: false };
                owners.set(payload.preparationId, owner); activeOwner = owner;
                if (model === "legacy-clean") {
                    await remote("sourceCombinedUnsupported404", async () => undefined);
                    await remote("sourcePrepare", async () => undefined);
                } else await remote("sourcePrepareAndAuthorize", async () => { owner.pending = decision(owner); });
                operationSignal?.throwIfAborted();
                return { grant: owner.grant, processFence: { epoch: crypto.randomUUID(), coordinatorDevice: "1",
                    coordinatorInode: "2", captureDevice: "1", captureInode: "3" } };
            }
            const owner = method === "sourcePreparationRelease" ? owners.get(payload.preparationId)
                : [...owners.values()].find(value => value.grant.sourceLeaseId === payload.sourceLeaseId);
            if (!owner) throw new Error("Unknown synthetic source owner");
            if (method === "sourceAuthorize") {
                if (model === "legacy-clean") await remote("sourceAuthorize", async () => { owner.pending = decision(owner); });
                else event("sourceAuthorize", "local-consume-once");
                const consume = async () => {
                    const prepared = owner.pending; owner.pending = null;
                    operationSignal?.throwIfAborted();
                    if (!prepared || owner.consumed || Date.parse(prepared.expiresAt) <= now()) throw new Error("Synthetic start decision unavailable");
                    owner.consumed = true; owner.consumedExpiresAt = Date.parse(prepared.expiresAt);
                    return prepared;
                };
                return timed("local.sourceAuthorizeConsume", 0, consume, "local-consume-once");
            }
            if (!["sourceStopped", "sourceRelease", "sourcePreparationRelease"].includes(method)) throw new Error("Unexpected synthetic native request");
            await remote(method, async () => { await beforeStop(method, payload); });
            for (const [id, value] of owners) if (value === owner) owners.delete(id);
            if (activeOwner === owner) activeOwner = undefined;
            return null;
        } };
    const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
        uploadTarget: { putCompleteEnvelope: async () => undefined } });
    await backend.listEncounters(signal);
    const mount = await backend.openEncounter(appointmentRef, signal);
    return { mount, events,
        retireSource: async () => {
            const count = events.length;
            await mount.retireSource();
            if (events.length === count) {
                event("retireSource", "no-op");
                await timed("noop.retireSource", 0, async () => undefined, "no-op");
            }
        },
        assertNativeStartAllowed: () => {
            if (!activeOwner?.consumed || activeOwner.pending || activeOwner.nativeStarted
                || activeOwner.consumedExpiresAt <= now() || activeOwner.deadline <= now()
                || signal.aborted) throw new Error("Synthetic native start before authority");
            activeOwner.nativeStarted = true;
        },
        ownerCount: () => owners.size,
        close: async () => { await mount.release(); await backend.dispose(); },
    };
}
