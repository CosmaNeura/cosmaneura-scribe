import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { selectOwnedIOSWebview, IOS_CONTEXT_ATTESTATION, IOS_CONTEXT_DISCOVERY } from './ios-webview.mjs';
import { AppiumUI } from './appium-ui.mjs';

const bundleId = 'com.cosmaneura.scribe.beta';
const contexts = () => [{ id: 'NATIVE_APP' },
  { id: 'WEBVIEW_6694.1', title: 'Cosmaneura Scribe Beta', bundleId, url: 'capacitor://localhost' },
  { id: 'WEBVIEW_6716.1', title: 'My account | Cosmas', bundleId: 'com.apple.SafariViewService', url: 'https://example.invalid/account' }];

test('fresh bundle and root URL distinguish Scribe from a retained hosted authentication view in either order', () => {
  const rows = contexts();
  assert.equal(selectOwnedIOSWebview(rows, bundleId), 'WEBVIEW_6694.1');
  assert.equal(selectOwnedIOSWebview(rows.reverse(), bundleId), 'WEBVIEW_6694.1');
  rows.find(x => x.bundleId === bundleId).id = 'WEBVIEW_9999.2';
  assert.equal(selectOwnedIOSWebview(rows, bundleId), 'WEBVIEW_9999.2');
});

test('missing, malformed, duplicate, foreign and multiple matching contexts remain fail closed', () => {
  const changes = [
    () => [], () => ['NATIVE_APP', 'WEBVIEW_6694.1'], () => [contexts()[1]],
    rows => { rows[1].bundleId = 'com.other.app'; }, rows => { delete rows[1].bundleId; },
    rows => { rows[1].id = 'WEBVIEW_unbound'; }, rows => { rows[2].id = rows[1].id; },
    rows => { rows.push({ ...rows[1], id: 'WEBVIEW_6694.2' }); },
    rows => { rows[1].url = 'https://localhost/'; }, rows => { rows[1].url = 'capacitor://elsewhere/'; },
    rows => { rows[1].url = 'capacitor://localhost/login'; }, rows => { rows[1].url = 'capacitor://localhost/?code=private'; },
    rows => { rows[1].url = 'capacitor://localhost/#foreign'; }, rows => { rows[1].url = 'capacitor://user:secret@localhost/'; },
    rows => { rows[1].url = 'capacitor://localhost:443/'; }, rows => { rows[1].url = null; },
  ];
  for (const change of changes) {
    const rows = contexts(), replacement = change(rows);
    assert.throws(() => selectOwnedIOSWebview(replacement ?? rows, bundleId), /owned_webview_ambiguous/);
  }
  assert.throws(() => selectOwnedIOSWebview(contexts(), ''), /owned_webview_ambiguous/);
});

test('post-switch attestation requires the unchanged local root and actual Capacitor bridge', () => {
  const attest = new Function('window', IOS_CONTEXT_ATTESTATION);
  const window = { location: { href: 'capacitor://localhost/' }, Capacitor: { nativePromise() {}, fromNative() {} } };
  assert.equal(attest(window), true);
  for (const href of ['https://example.invalid', 'capacitor://localhost/?secret=value', 'capacitor://user@localhost/', 'capacitor://localhost/elsewhere'])
    assert.equal(attest({ ...window, location: { href } }), false);
  assert.equal(attest({ ...window, Capacitor: {} }), false);
});

test('observer work selects only the current owned view and returns to native context', async () => {
  const ui = new AppiumUI('/unused'); ui.config = { app: { bundleId } };
  let context = 'NATIVE_APP', inspected = 0, effects = 0; const selected = [];
  ui.rawRequest = async (path, method = 'GET', body) => {
    if (path === '/context' && method === 'GET') return context;
    if (body?.script === IOS_CONTEXT_DISCOVERY.script) { assert.equal(context, 'NATIVE_APP'); inspected++; return contexts(); }
    if (path === '/context') { selected.push(body.name); context = body.name; return null; }
    if (body?.script === IOS_CONTEXT_ATTESTATION) { assert.equal(context, 'WEBVIEW_6694.1'); return true; }
    assert.equal(context, 'WEBVIEW_6694.1'); effects++; return 'owned observation';
  };
  assert.equal(await ui.webview('return ownObserver.read()'), 'owned observation');
  assert.equal(await ui.webview('return ownObserver.read()'), 'owned observation');
  assert.equal(inspected, 2); assert.equal(effects, 2);
  assert.deepEqual(selected, ['WEBVIEW_6694.1', 'NATIVE_APP', 'WEBVIEW_6694.1', 'NATIVE_APP']);
});

test('changed post-switch identity restores native context before any observer work', async () => {
  const ui = new AppiumUI('/unused'); ui.config = { app: { bundleId } };
  let context = 'NATIVE_APP', effects = 0;
  ui.rawRequest = async (path, method = 'GET', body) => {
    if (path === '/context' && method === 'GET') return context;
    if (body?.script === IOS_CONTEXT_DISCOVERY.script) return contexts();
    if (path === '/context') { context = body.name; return null; }
    if (body?.script === IOS_CONTEXT_ATTESTATION) return false;
    effects++; return null;
  };
  await assert.rejects(ui.webview('return ownObserver.uninstall()'), /owned_webview_identity_changed/);
  assert.equal(effects, 0); assert.equal(context, 'NATIVE_APP'); assert.equal(ui.contextUncertain, false);
});

test('cleanup refuses missing or duplicate app ownership and changed page identity without uninstalling', async () => {
  let context = 'NATIVE_APP', rows = contexts(), attested = false, effects = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : null; let value = null;
    if (request.url.endsWith('/context') && request.method === 'GET') value = context;
    else if (request.url.endsWith('/context')) context = body.name;
    else if (body.script === IOS_CONTEXT_DISCOVERY.script) value = rows;
    else if (body.script === IOS_CONTEXT_ATTESTATION) value = attested;
    else { effects++; value = { ownedResourcesSettled: true, observerRemoved: true }; }
    response.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = new AppiumUI('/unused'); ui.session = 'owned';
    ui.config = { app: { bundleId }, target: { role: 'owned-ios-simulator' }, admissionBinding: { runId: 'owned-test' } };
    ui.base = `http://127.0.0.1:${server.address().port}`;
    for (const observed of [contexts(), [{ id: 'NATIVE_APP' }], [...contexts(), { ...contexts()[1], id: 'WEBVIEW_6694.2' }]]) {
      rows = observed;
      assert.equal((await ui.cleanupIOSObservers(false)).ownedResourcesSettled, false);
      assert.equal(effects, 0); assert.equal(context, 'NATIVE_APP');
    }
    rows = contexts(); attested = true;
    assert.equal((await ui.cleanupIOSObservers(false)).ownedResourcesSettled, true);
    assert.equal(effects, 1); assert.equal(context, 'NATIVE_APP');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
