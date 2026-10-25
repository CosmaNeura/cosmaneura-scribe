import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installVisitScopeObserver } from "./visit-observer.mjs";

test('retained visit observer cannot remove wrappers while a native request remains pending', async () => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; }), original = () => pending;
  globalThis.window = { Capacitor: { nativePromise: original, fromNative: () => {} } };
  installVisitScopeObserver({ runId: '11111111-1111-4111-8111-111111111111', observerSHA256: 'b'.repeat(64) });
  const observer = window.__scribeLabVisitObserver;
  window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'getState', {});
  assert.equal(observer.describe().observerSHA256, 'b'.repeat(64));
  assert.equal(observer.describe().pendingObservedReplies, 1);
  assert.equal(observer.uninstall().ownedResourcesSettled, false);
  settle(null); await pending;
  assert.equal(observer.describe().pendingObservedReplies, 0);
  assert.equal(observer.uninstall().ownedResourcesSettled, true);
  assert.equal(window.Capacitor.nativePromise, original);
});
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

test('auth receipt projects a normal ready reply only and expires without fresh native work', async () => {
  let now = 100, result = Promise.resolve({ phase: 'ready', revision: id(3), identity: {
    userId: 'user_syntheticA', sessionId: 'sess_private', token: 'never-retained' }, providerDisplayName: 'never-retained' });
  const original = () => result;
  const context = vm.createContext({ window: { Capacitor: { nativePromise: original, fromNative: value => value } },
    performance: { now: () => now, timeOrigin: 1000 } });
  vm.runInContext(`(${installVisitScopeObserver.toString()})`, context)({ runId: id(1) });
  const cap = context.window.Capacitor, observer = context.window.__scribeLabVisitObserver;
  assert.equal(observer.readAuth(), null);
  assert.equal(cap.nativePromise('CosmasWorkspaceAuth', 'getState', {}), result); await result;
  await new Promise(resolve => setImmediate(resolve));
  const receipt = observer.readAuth();
  assert.deepEqual(Object.keys(receipt).sort(), ['source', 'runId', 'phase', 'revision', 'userId', 'observedAtMonotonicMs', 'browserTimeOriginMs'].sort());
  assert.equal(receipt.source, 'normal-native-auth-response'); assert.equal(receipt.userId, 'user_syntheticA');
  assert(!JSON.stringify(receipt).includes('never-retained')); assert(!JSON.stringify(receipt).includes('sess_private'));
  now += 15001; assert.equal(observer.readAuth(), null);
  // A mounted visit never upgrades the old auth identity into fresh proof.
  result = Promise.resolve(mounted); await cap.nativePromise('CosmasWorkspaceAuth', 'providerRequest', mount);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.readAuth(), null);
  result = Promise.resolve({ phase: 'ready', revision: id(3) });
  await cap.nativePromise('CosmasWorkspaceAuth', 'getProviderState', {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(observer.readAuth(), null);
  assert.equal(observer.uninstall().ownedResourcesSettled, true);
});

test('pending sign out, late polls and auth changes cannot resurrect an old account', async () => {
  let resolveOld, resolveSignOut;
  const old = new Promise(resolve => { resolveOld = resolve; }), signOut = new Promise(resolve => { resolveSignOut = resolve; });
  const ready = user => ({ phase: 'ready', revision: id(user === 'user_A' ? 3 : 33), identity: { userId: user } });
  let result = Promise.resolve(ready('user_A'));
  globalThis.window = { Capacitor: { nativePromise: () => result, fromNative: value => value } };
  installVisitScopeObserver({ runId: id(1) });
  const observer = window.__scribeLabVisitObserver, cap = window.Capacitor;
  await cap.nativePromise('CosmasWorkspaceAuth', 'getState', {}); assert.equal(observer.readAuth().userId, 'user_A');
  result = old; cap.nativePromise('CosmasWorkspaceAuth', 'getState', {});
  result = signOut; assert.equal(cap.nativePromise('CosmasWorkspaceAuth', 'signOut', {}), signOut);
  assert.equal(observer.readAuth(), null); assert.equal(observer.uninstall().ownedResourcesSettled, false);
  resolveOld(ready('user_A')); await old; assert.equal(observer.readAuth(), null);
  const event = { pluginId: 'CosmasWorkspaceAuth', methodName: 'addListener', success: true, data: ready('user_A') };
  assert.equal(cap.fromNative(event), event); assert.equal(observer.readAuth(), null);
  resolveSignOut({ phase: 'signedOut', revision: id(34), identity: null }); await signOut;
  assert.equal(observer.readAuth(), null);
  result = Promise.resolve(ready('user_B')); await cap.nativePromise('CosmasWorkspaceAuth', 'getProviderState', {});
  assert.equal(observer.readAuth().userId, 'user_B');
  cap.fromNative({ ...event, data: { phase: 'unavailable', revision: id(35) } }); assert.equal(observer.readAuth(), null);
  assert.equal(observer.uninstall().ownedResourcesSettled, true);
});

test('newer auth polls and native events retire older auth replies and failed newest reads', async () => {
  let resolveOld, result;
  globalThis.window = { Capacitor: { nativePromise: () => result, fromNative: () => undefined } };
  installVisitScopeObserver({ runId: id(1) });
  const observer = window.__scribeLabVisitObserver, cap = window.Capacitor;
  const ready = (userId, revision) => ({ phase: 'ready', revision, identity: { userId } });
  result = new Promise(resolve => { resolveOld = resolve; }); const old = result;
  cap.nativePromise('CosmasWorkspaceAuth', 'getState', {});
  result = Promise.resolve(ready('user_B', id(33))); await cap.nativePromise('CosmasWorkspaceAuth', 'getState', {});
  resolveOld(ready('user_A', id(3))); await old; assert.equal(observer.readAuth().userId, 'user_B');
  result = Promise.reject(Error('normal auth unavailable'));
  await assert.rejects(cap.nativePromise('CosmasWorkspaceAuth', 'getState', {})); assert.equal(observer.readAuth(), null);
  cap.fromNative({ pluginId: 'CosmasWorkspaceAuth', methodName: 'getState', success: true, data: ready('user_A', id(3)) });
  assert.equal(observer.readAuth(), null, 'uncorrelated promise envelope cannot manufacture identity');
  observer.uninstall();
});
