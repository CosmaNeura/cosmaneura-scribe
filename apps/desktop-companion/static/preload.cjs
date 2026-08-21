"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const MAX_BYTES = 16 * 1024;
const STATE_CHANNEL = "cosmas:desktop:state-changed:v1";
const channels = Object.freeze({
  getState: "cosmas:desktop:get-state:v1",
  refreshPermissions: "cosmas:desktop:refresh-permissions:v1",
  start: "cosmas:desktop:start:v1",
  stop: "cosmas:desktop:stop:v1",
});
const states = new Set([
  "permission_required",
  "meeting_detected",
  "ready",
  "recording",
  "stopped",
  "failed",
]);
const failures = new Set([
  "adapter_failure",
  "authority_changed",
  "authority_revoked",
  "authority_stale",
  "authority_unavailable",
  "capability_replayed",
  "device_changed",
  "feature_disabled",
  "indicator_failure",
  "invalid_transition",
  "lease_unavailable",
  "network_lost",
  "precondition_failed",
  "renderer_unauthorized",
]);

function fail() {
  throw new Error("Invalid desktop companion IPC response");
}

function record(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BYTES) fail();
  return value;
}

function identifier(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail();
  return value;
}

function stateEvent(value) {
  const parsed = record(value, ["schemaVersion", "requestId", "state", "captureSessionId", "reasonCode"]);
  if (parsed.schemaVersion !== 1 || !states.has(parsed.state)) fail();
  identifier(parsed.requestId, true);
  identifier(parsed.captureSessionId, true);
  if (parsed.reasonCode !== null && !failures.has(parsed.reasonCode)) fail();
  if ((parsed.state === "failed") !== (parsed.reasonCode !== null)) fail();
  return Object.freeze({ ...parsed });
}

function commandResult(value) {
  const parsed = record(value, ["schemaVersion", "requestId", "ok", "errorCode"]);
  if (parsed.schemaVersion !== 1 || typeof parsed.ok !== "boolean") fail();
  identifier(parsed.requestId);
  if (parsed.errorCode !== null && !failures.has(parsed.errorCode)) fail();
  if (parsed.ok === (parsed.errorCode !== null)) fail();
  return Object.freeze({ ...parsed });
}

function request(kind) {
  const requestId = crypto.randomUUID();
  return Object.freeze({ schemaVersion: 1, kind, requestId });
}

async function invoke(kind) {
  const command = kind === "refreshPermissions" ? "refresh_permissions" : kind;
  return commandResult(await ipcRenderer.invoke(channels[kind], request(command)));
}

const api = Object.freeze({
  async getState() {
    const requestId = crypto.randomUUID();
    return stateEvent(await ipcRenderer.invoke(channels.getState, Object.freeze({ schemaVersion: 1, requestId })));
  },
  refreshPermissions: async () => invoke("refreshPermissions"),
  start: async () => invoke("start"),
  stop: async () => invoke("stop"),
  onStateChanged(listener) {
    if (typeof listener !== "function") fail();
    const wrapped = (_event, payload) => listener(stateEvent(payload));
    ipcRenderer.on(STATE_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, wrapped);
  },
});

contextBridge.exposeInMainWorld("cosmasDesktop", api);
