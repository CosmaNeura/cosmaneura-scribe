// Render the actual retained bundle in an offline DOM. No browser automation,
// native app, identity provider, HTTP server or real credentials are involved.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
import { repairBundle } from "./prepare.mjs";

const [input, jsdomModule] = process.argv.slice(2);
if (!input || !jsdomModule) throw new Error("Usage: recovery.test.mjs retained-entry.js installed-jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomModule));
const bytes = await readFile(input);
const corrected = await repairBundle(bytes);
const first = { phase: "ready", revision: "00000000-0000-4000-8000-000000000001",
  identity: { userId: "user_fixture", sessionId: "sess_fixture", organizationId: "org_fixture" } };
const unavailable = { phase: "unavailable", revision: "00000000-0000-4000-8000-000000000002", identity: null };
const restored = { ...first, revision: "00000000-0000-4000-8000-000000000003" };
const signedOut = { phase: "signedOut", revision: "00000000-0000-4000-8000-000000000004", identity: null };
const result = [{ appointment_id: "invented_visit", workspace_id: null, label: "Invented private visit" }];
const token = "offline.fixture.only";
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

async function harness(bundle) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const window = dom.window;
  Object.assign(window, { Headers, Response, AbortController, TextEncoder, TextDecoder });
  const intervals = new Map();
  const deadlines = new Map();
  const realTimeout = window.setTimeout.bind(window);
  const realClear = window.clearTimeout.bind(window);
  window.setInterval = (callback, ms) => { assert.equal(ms, 5000); intervals.set(1, callback); return 1; };
  window.clearInterval = id => intervals.delete(id);
  window.setTimeout = (callback, ms, ...args) => {
    if (ms !== 30000) return realTimeout(callback, ms, ...args);
    deadlines.set(900001, callback); return 900001;
  };
  window.clearTimeout = id => { deadlines.delete(id); realClear(id); };
  let state = first;
  let listener;
  let tokenRequests = 0;
  let requests = 0;
  let fetchImpl = async () => new Response(JSON.stringify(result));
  let tokenImpl = async ({ expectedRevision }) => ({ token, revision: expectedRevision });
  window.fetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8046/workspaces");
    assert.equal(options.headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(options.credentials, "omit");
    requests++;
    return fetchImpl(url, options);
  };
  const plugin = {
    getState: async () => structuredClone(state),
    getToken: async options => { tokenRequests++; return tokenImpl(options); },
    addListener: async (_event, callback) => { listener = callback; return { remove: async () => { listener = undefined; } }; },
    signOut: async () => { state = signedOut; },
    signIn: async () => { throw new Error("Unrequested sign-in"); },
  };
  const mount = 'Vp.createRoot(document.getElementById("root")).render(f.jsx(O.StrictMode,{children:f.jsx(J1,{})}));';
  const exports = 'export{Kl as A,Gj as e,Vj as p,go as r,Yj as t};';
  assert.equal(bundle.split(mount).length, 2);
  assert.equal(bundle.split(exports).length, 2);
  // Leave all production component/transport code intact; substitute only the
  // bootstrap so the existing injectable native adapter can use offline fixtures.
  const module = new SourceTextModule(bundle.replace(mount, "").replace(exports,
    'globalThis.fixtureMount=p=>{const root=Vp.createRoot(document.getElementById("root"));root.render(f.jsx(Q1,{plugin:p,available:true}));return root};'),
  { context: dom.getInternalVMContext(), initializeImportMeta: meta => { meta.url = "capacitor://localhost/assets/fixture.js"; } });
  await module.link(() => { throw new Error("Unexpected external module"); });
  await module.evaluate();
  const root = window.fixtureMount(plugin);
  async function settle() { for (let i = 0; i < 5; i++) await pause(); }
  await settle();
  return {
    text: () => window.document.body.textContent,
    async click(label) {
      const button = [...window.document.querySelectorAll("button")].find(item => item.textContent.startsWith(label));
      assert.ok(button, `Missing ${label}`); assert.equal(button.disabled, false);
      button.click(); await settle();
    },
    setFetch: value => { fetchImpl = value; }, setToken: value => { tokenImpl = value; },
    async emit(value) { state = value; listener?.(value); await settle(); },
    async poll() { for (const callback of intervals.values()) callback(); await settle(); },
    async timeout() { for (const callback of [...deadlines.values()]) callback(); await settle(); },
    requests: () => requests, tokenRequests: () => tokenRequests, deadlines: () => deadlines.size,
    async close() { root.unmount(); await settle(); window.close(); },
  };
}

async function tokenRecovery(bundle, repaired) {
  const h = await harness(bundle);
  try {
    h.setToken(async () => { await h.emit(unavailable); throw new Error("private provider detail"); });
    await h.click("Choose an encounter");
    assert.equal(h.requests(), 0);
    await h.emit(restored);
    assert.ok(h.text().includes("Choose an encounter"));
    assert.equal(h.text().includes("Workspace access could not be verified"), repaired);
    assert.equal(h.text().includes("private provider detail"), false);
    await h.poll();
    assert.equal(h.text().includes("Workspace access could not be verified"), repaired);
    h.setToken(async ({ expectedRevision }) => ({ token, revision: expectedRevision }));
    await h.click("Choose an encounter");
    assert.ok(h.text().includes("Invented private visit"));
    assert.equal(h.text().includes("Workspace access could not be verified"), false);
    await h.poll();
    assert.ok(h.text().includes("Invented private visit"));
    await h.click("Sign out");
    assert.equal(h.text().includes("Invented private visit"), false);
    assert.ok(h.text().includes("Sign in to Cosmas"));
  } finally { await h.close(); }
}
await tokenRecovery(bytes.toString("utf8"), false);
console.log("Confirmed original bundle loses the token-failure message after native ready restoration.");
await tokenRecovery(corrected, true);
console.log("Corrected bundle retains failure, retries explicitly, preserves the encounter on polling, and clears on logout.");

const h = await harness(corrected);
try {
  h.setFetch(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("private transport detail")), { once: true });
  }));
  await h.click("Choose an encounter");
  assert.ok(h.text().includes("Loading"));
  assert.equal(h.deadlines(), 1);
  await h.timeout();
  assert.ok(h.text().includes("Could not connect to the workspace service"));
  assert.equal(h.text().includes("private transport detail"), false);
  assert.equal(h.deadlines(), 0);
  await h.poll();
  assert.ok(h.text().includes("Could not connect to the workspace service"));
  h.setFetch(async () => new Response(JSON.stringify(result)));
  await h.click("Choose an encounter");
  assert.ok(h.text().includes("Invented private visit"));
  assert.equal(h.deadlines(), 0);
  assert.equal(h.requests(), 2);
  assert.equal(h.tokenRequests(), 2);
} finally { await h.close(); }
console.log("Encounter read timeout and explicit retry pass against the corrected bundle; no live requests made.");

const late = await harness(corrected);
try {
  let finish;
  late.setToken(() => new Promise(resolve => { finish = resolve; }));
  await late.click("Choose an encounter");
  await late.click("Sign out");
  finish({ token, revision: first.revision });
  await late.poll();
  assert.equal(late.requests(), 0);
  assert.equal(late.text().includes("Invented private visit"), false);
  assert.ok(late.text().includes("Sign in to Cosmas"));
} finally { await late.close(); }
console.log("A token completing after logout cannot send a workspace request or restore private content.");
await assert.rejects(repairBundle(Buffer.from("different candidate")), /Unrecognized W13 input/);
