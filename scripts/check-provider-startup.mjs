// Existing JSDOM/TypeScript tooling; no device, microphone, auth or network.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
import ts from "typescript";

const [rendererPath, jsdomPath] = process.argv.slice(2);
if (!rendererPath || !jsdomPath) throw new Error("Usage: check-provider-startup.mjs standalone-build jsdom-module");
const { JSDOM, VirtualConsole } = await import(pathToFileURL(jsdomPath));
const html = await readFile(resolve(rendererPath, "index.html"), "utf8");
const source = await readFile(new URL("../apps/capture/src/provider/startup.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const configuration = { enabled: true, coreOrigin: "https://staging-app.cosmaneura.com", uploadOrigins: ["https://fixture.blob.core.windows.net"] };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(done => setTimeout(done, 10));
const forbidden = () => { throw new Error("Unexpected native, network or module operation"); };
let checks = 0;
async function fixture() {
  const dom = new JSDOM(html, { url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true });
  const root = dom.window.document.getElementById("app");
  assert.ok(root.textContent.includes("Opening Scribe"));
  const module = new SourceTextModule(code, { context: dom.getInternalVMContext() });
  await module.link(forbidden); await module.evaluate();
  const config = deferred(), application = deferred();
  let reads = 0, loads = 0, mounts = 0, closes = 0;
  const mount = () => { mounts++; root.textContent = "Mounted"; return async () => { closes++; }; };
  const host = { configuration: () => { reads++; return config.promise; }, application: () => { loads++; return application.promise; } };
  return { dom, root, config, application, mount, host, start: () => module.namespace.mountProviderStartup(root, host),
    counts: () => ({ reads, loads, mounts, closes }) };
}
{
  const f = await fixture(), close = f.start();
  assert.deepEqual(f.counts(), { reads: 1, loads: 1, mounts: 0, closes: 0 });
  assert.equal(f.root.getAttribute("aria-busy"), "true");
  f.config.resolve(configuration); await turn(); assert.equal(f.counts().mounts, 0);
  f.application.resolve({ mount: f.mount }); await turn(); assert.equal(f.counts().mounts, 1);
  await close(); assert.equal(f.counts().closes, 1); f.dom.window.close(); checks++;
}
for (const failed of ["config", "application"]) {
  const f = await fixture(), close = f.start();
  f[failed].reject(new Error("Private implementation detail")); await turn();
  assert.ok(f.root.textContent.includes("Retry opening Scribe"));
  assert.ok(!f.root.textContent.includes("Private implementation detail"));
  const retryConfig = deferred();
  f.host.configuration = () => retryConfig.promise;
  f.host.application = async () => ({ mount: f.mount });
  const retry = f.root.querySelector("button"); retry.click(); retry.click();
  // A late successful reply from the failed attempt must never mount an owner.
  f[failed === "config" ? "application" : "config"].resolve(failed === "config" ? { mount: f.mount } : configuration);
  await turn(); assert.equal(f.counts().mounts, 0);
  retryConfig.resolve(configuration); await turn(); assert.equal(f.counts().mounts, 1);
  await close(); f.dom.window.close(); checks++;
}
for (const value of [{ ...configuration, enabled: false }, { ...configuration, coreOrigin: "https://wrong.invalid" },
  { ...configuration, uploadOrigins: [] }, { ...configuration, uploadOrigins: ["https://wrong.invalid"] }]) {
  const f = await fixture(), close = f.start();
  f.config.resolve(value); f.application.resolve({ mount: f.mount }); await turn();
  assert.equal(f.counts().mounts, 0);
  assert.ok(f.root.textContent.includes(value.enabled ? "Scribe could not open" : "Setup required"));
  await close(); f.dom.window.close(); checks++;
}
{
  const f = await fixture(), close = f.start(); await close();
  f.config.resolve(configuration); f.application.resolve({ mount: f.mount }); await turn();
  assert.equal(f.counts().mounts, 0); f.dom.window.close(); checks++;
}
{
  const f = await fixture(), close = f.start();
  f.config.resolve(configuration); f.application.resolve({ mount: () => { throw new Error("Partial owner"); } }); await turn();
  assert.ok(f.root.textContent.includes("Close Scribe and reopen it"));
  assert.equal(f.root.querySelector("button"), null); await close(); f.dom.window.close(); checks++;
}
// Load the actual emitted entry and lazy application graph. Native session state
// is signed out; any permission, token, storage, Core or recording call fails.
{
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(html, { url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const w = dom.window, root = w.document.getElementById("app"), pending = deferred(), calls = [];
  Object.defineProperty(w, "crypto", { value: webcrypto });
  Object.assign(w, { Headers, Response, TextEncoder, TextDecoder, structuredClone, fetch: async url => {
    // Vite's modulepreload polyfill reads packaged assets. Serve only those
    // local bytes; an HTTP request or non-asset path fails this check.
    const target = new URL(url, w.location.href);
    assert.equal(target.protocol, "capacitor:"); assert.equal(target.hostname, "localhost");
    assert.match(target.pathname, /^\/assets\/[a-zA-Z0-9_-]+\.js$/u);
    return new Response(await readFile(resolve(rendererPath, "." + target.pathname)));
  } });
  w.CapacitorCustomPlatform = { name: "ios" };
  w.Capacitor = { PluginHeaders: [
    { name: "CosmasWorkspaceAuth", methods: ["getProviderConfiguration", "getState", "removeListener"].map(name => ({ name, rtype: "promise" }))
      .concat([{ name: "addListener", rtype: "callback" }]) }, { name: "IOSPCM", methods: [] }, { name: "SecureQueue", methods: [] }],
  nativeCallback(plugin, method) { assert.equal(plugin, "CosmasWorkspaceAuth"); assert.equal(method, "addListener"); return "synthetic-listener"; },
  async nativePromise(plugin, method) {
    assert.equal(plugin, "CosmasWorkspaceAuth"); calls.push(method);
    if (method === "getProviderConfiguration") return pending.promise;
    if (method === "getState") return { phase: "signedOut", revision: webcrypto.randomUUID() };
    if (method === "removeListener") return;
    return forbidden();
  } };
  // JSDOM has no stylesheet loader. Settle only the local Vite CSS preloads.
  const observer = new w.MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof w.HTMLLinkElement && node.rel === "stylesheet") node.dispatchEvent(new w.Event("load"));
    }
  });
  observer.observe(w.document.head, { childList: true });
  const modules = new Map(), base = resolve(rendererPath), context = dom.getInternalVMContext();
  const load = async path => {
    path = resolve(path); assert.ok(path.startsWith(base + sep) && path.endsWith(".js"));
    if (modules.has(path)) return modules.get(path);
    const module = new SourceTextModule(await readFile(path, "utf8"), { context, identifier: pathToFileURL(path).href,
      initializeImportMeta(meta) { meta.url = "capacitor://localhost/" + relative(base, path); },
      importModuleDynamically: async (name, referencing) => {
        const loaded = await load(fileURLToPath(new URL(name, referencing.identifier)));
        if (loaded.status === "unlinked") await loaded.link(link);
        await loaded.evaluate(); return loaded;
      } });
    modules.set(path, module); return module;
  };
  const link = (name, referencing) => load(fileURLToPath(new URL(name, referencing.identifier)));
  const entry = dom.window.document.querySelector('script[type="module"]').getAttribute("src");
  const module = await load(resolve(base, entry)); await module.link(link); await module.evaluate();
  await turn(); assert.ok(root.textContent.includes("Opening Scribe")); assert.deepEqual(calls, ["getProviderConfiguration"]);
  pending.resolve(configuration);
  for (let i = 0; i < 100 && !root.textContent.includes("Welcome to Scribe"); i++) await turn();
  assert.ok(root.textContent.includes("Welcome to Scribe"));
  assert.equal(root.querySelector('[data-session-action="sign-in"]').textContent, "Sign in");
  w.dispatchEvent(new w.Event("pagehide")); await turn();
  assert.ok(calls.includes("removeListener")); assert.deepEqual(errors, []);
  observer.disconnect(); dom.window.close(); checks++;
}
console.log(JSON.stringify({ checks_passed: checks, actual_standalone_bundle: true, native_session: "synthetic-signed-out",
  microphone_opened: false, network_used: false, device_startup_latency_measured: false }));
