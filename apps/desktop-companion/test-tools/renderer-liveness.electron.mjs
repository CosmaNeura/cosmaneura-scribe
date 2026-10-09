import { app, BrowserWindow, session } from "electron";
import assert from "node:assert/strict";
import { MainRecordingWindow } from "../src/recording-window.ts";

// This process loads only the invented data page below. It never imports the
// Scribe host, capture, auth, persistence, helper, or meeting application.
app.setName("Scribe virtual renderer liveness check");
app.setPath("userData", process.env.SCRIBE_LIVENESS_TEST_DIR);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = "application-ready";
const watchdog = setTimeout(() => { process.stderr.write(`Virtual renderer check exceeded 15 seconds at ${stage}.\n`); app.exit(1); }, 15000);
let window;
async function run() {
try {
  await app.whenReady();
  const sandbox = session.fromPartition("scribe-virtual-renderer-liveness");
  sandbox.setPermissionCheckHandler(() => false);
  sandbox.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  sandbox.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !request.url.startsWith("data:") }));
  window = new BrowserWindow({ show: false, width: 480, height: 360,
    webPreferences: { session: sandbox, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  stage = "invented-page-load";
  await window.loadURL("data:text/html,<meta charset=utf-8><title>Invented renderer check</title><button>Invented Stop control</button>");
  stage = "healthy-round-trip";
  let pending = 0, maxPending = 0, probeCount = 0;
  const probe = () => {
    probeCount += 1; pending += 1; maxPending = Math.max(maxPending, pending);
    return window.webContents.executeJavaScript("0", false).finally(() => { pending -= 1; });
  };
  // Synthetic window metadata isolates renderer liveness. The actual window
  // stays hidden, and no helper is spawned or told it is visible. Native OS
  // visibility/owner validation has separate Swift metadata tests.
  const port = { isDestroyed: () => window.isDestroyed(), isVisible: () => true, isMinimized: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 780, height: 760 }), getMinimumSize: () => [520, 520],
    getMediaSourceId: () => window.getMediaSourceId(), setBounds() {}, setMinimumSize() {},
    setAlwaysOnTop() {}, setVisibleOnAllWorkspaces() {}, showInactive() {} };
  const controller = new MainRecordingWindow(() => port, () => ({ x: 0, y: 0, width: 1440, height: 900 }), probe);
  controller.update({ state: "recording", desktop: { phase: "recording" } });
  assert.equal(controller.primaryWindowId(), null);
  await wait(100);
  const healthyID = controller.primaryWindowId();
  assert.ok(Number.isSafeInteger(healthyID) && healthyID > 0);
  await wait(100); // let the second healthy round trip finish
  stage = "stalled-renderer";
  const started = performance.now();
  // Finite deliberate renderer stall, with the main process event loop free.
  const stall = window.webContents.executeJavaScript("(() => { const until = performance.now() + 4000; while (performance.now() < until) {} return 0; })()", false);
  let withdrawnAt = null;
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await wait(200);
    const elapsed = performance.now() - started;
    const offered = controller.primaryWindowId();
    samples.push({ elapsed_ms: Math.round(elapsed), offers_primary_window: offered !== null });
    if (offered === null && withdrawnAt === null) withdrawnAt = elapsed;
  }
  assert.ok(withdrawnAt !== null && withdrawnAt <= 1800, "stalled renderer retained its window offer beyond the freshness budget");
  assert.equal(maxPending, 1, "responsiveness probes were not single flight");
  assert.equal(pending, 1, "the renderer was no longer stalled during the withdrawal check");
  stage = "renderer-recovery";
  await stall;
  await wait(100); // the expired no-op resolves; it must not restore coverage
  assert.equal(controller.primaryWindowId(), null);
  await wait(100);
  assert.equal(controller.primaryWindowId(), healthyID);
  controller.block();
  assert.equal(controller.primaryWindowId(), null);
  process.stdout.write(JSON.stringify({ status: "passed", electron: process.versions.electron,
    renderer_stall_ms: 4000, primary_offer_withdrawn_ms: Math.round(withdrawnAt), max_pending_probes: maxPending,
    probe_count: probeCount, samples, hidden_window: true, native_helper_started: false, audio_or_network_requested: false }) + "\n");
  window.destroy(); clearTimeout(watchdog); app.exit(0);
} catch (error) {
  process.stderr.write(String(error) + "\n");
  if (window && !window.isDestroyed()) window.destroy();
  clearTimeout(watchdog); app.exit(1);
}
}
void run();
