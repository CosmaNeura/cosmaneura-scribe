import assert from "node:assert/strict";
import test from "node:test";
import { installVisitScopeObserver } from "./visit-observer.mjs";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = "appointment_01m5q8r3kzeng9szb5frh6ppk3";
const create = { requestId: id(2), revision: id(3), action: "encounters", body: JSON.stringify({
  action: "create", creation_key: id(4), request_nonce: id(5), patient: { name: "never retained" } }) };
const created = { requestId: id(2), revision: id(3), status: 200, body: JSON.stringify({
  revision: id(3), creation_key: id(4), encounter: { workspace_id: id(6), appointment_ref: ref,
    patient_name: "never retained", date_of_birth: "never retained" } }) };
const mount = { requestId: id(7), revision: id(3), action: "mount", body: JSON.stringify({ workspace_id: id(6) }) };
const mounted = { requestId: id(7), revision: id(3), status: 200, body: JSON.stringify({
  revision: id(3), workspaceId: id(6), appointmentRef: ref, bindingRef: "never retained" }) };

test("observes actual creation and current mount without copying private body fields", async () => {
  let result = Promise.resolve(created), clears = 0, forwarded;
  const original = () => result, fromNative = value => { forwarded = value; return 42; };
  globalThis.window = { Capacitor: { nativePromise: original, fromNative },
    __scribeLabAdmissionObserver: { clear() { clears += 1; } } };
  installVisitScopeObserver({ runId: id(1) });
  assert.equal(window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", create), result);
  await result;
  const observer = window.__scribeLabVisitObserver;
  assert.equal(observer.readCreated().workspaceId, id(6)); assert.equal(observer.readCurrent(), null);
  result = Promise.resolve(mounted);
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", mount);
  assert.equal(observer.readCurrent().appointmentRef, ref);
  assert(!JSON.stringify(observer.readCurrent()).includes("never retained"));
  const envelope = { pluginId: "CosmasWorkspaceAuth", methodName: "addListener", success: true,
    data: { phase: "ready", revision: id(33), providerDisplayName: "never retained" } };
  assert.equal(window.Capacitor.fromNative(envelope), 42); assert.equal(forwarded, envelope);
  assert.equal(observer.readCurrent(), null); assert.equal(observer.readCreated(), null);
  assert(clears >= 3); observer.uninstall();
  assert.equal(window.Capacitor.nativePromise, original); assert.equal(window.Capacitor.fromNative, fromNative);
});

test("late mount cannot overwrite a later mount or survive sign out", async () => {
  let finish, result = new Promise(resolve => { finish = resolve; });
  globalThis.window = { Capacitor: { nativePromise: () => result, fromNative: () => undefined } };
  installVisitScopeObserver({ runId: id(1) });
  window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", mount);
  result = Promise.resolve({ ...mounted, requestId: id(8) });
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", { ...mount, requestId: id(8) });
  finish(mounted); await Promise.resolve();
  assert.equal(window.__scribeLabVisitObserver.readCurrent().requestId, id(8));
  window.Capacitor.nativePromise("CosmasWorkspaceAuth", "signOut", {});
  assert.equal(window.__scribeLabVisitObserver.readCurrent(), null);
  window.__scribeLabVisitObserver.uninstall();
});
