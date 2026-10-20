import { expect, it } from "vitest";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreBootstrapDiagnostics, StoreBridgeDiagnosticDecoder } from "./store-bootstrap-diagnostics.js";

it("reports a pre-directory failure without a data path or arbitrary error", async () => {
  const lines: string[] = [], diagnostics = new StoreBootstrapDiagnostics(line => { lines.push(line); });
  diagnostics.enter(2);
  diagnostics.observeBridge("arbitrary private value", 10);
  await diagnostics.failed();
  expect(lines).toEqual(["SCRIBE_STORE_BOOTSTRAP:2\n"]);
});

it("retains a closed shell substage and ignores out-of-range or fractional observations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-bootstrap-")));
  try {
    const lines: string[] = [], diagnostics = new StoreBootstrapDiagnostics(line => { lines.push(line); });
    diagnostics.bindValidatedDirectory(root); diagnostics.enter(18);
    diagnostics.enter(19 as never); diagnostics.enter(1.5 as never); diagnostics.enter(NaN as never);
    await diagnostics.failed();
    expect(lines).toEqual(["SCRIBE_STORE_BOOTSTRAP:18\n"]);
    expect(JSON.parse(await readFile(join(root, "store-bootstrap-diagnostics-v1.jsonl"), "utf8")))
      .toEqual({ event: "store_bootstrap_failed", pid: process.pid, reason_code: 18 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("persists only the closed stage, bridge category and actual exit before returning", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-bootstrap-")));
  try {
    const lines: string[] = [], diagnostics = new StoreBootstrapDiagnostics(line => { lines.push(line); });
    diagnostics.bindValidatedDirectory(root); diagnostics.enter(7);
    diagnostics.observeBridge("store_bridge_failed", 10);
    diagnostics.observeBridge("store_bridge_failed", 11);
    diagnostics.observeBridge("store_bridge_failed", 15);
    diagnostics.observeBridge("store_bridge_exit", 0);
    diagnostics.observeBridge("store_bridge_signal", 1.5);
    await diagnostics.failed();
    const value = JSON.parse(await readFile(join(root, "store-bootstrap-diagnostics-v1.jsonl"), "utf8"));
    expect(value).toEqual({ event: "store_bootstrap_failed", pid: process.pid, reason_code: 7,
      bridge_reason_code: 10, bridge_exit_code: 0 });
    expect(lines).toEqual(["SCRIBE_STORE_BOOTSTRAP:7\n", "SCRIBE_STORE_BRIDGE:10\n", "SCRIBE_STORE_BRIDGE_EXIT:0\n"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses a linked or broad directory without changing the retained fixture", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-bootstrap-")));
  try {
    const retained = join(root, "retained"); await mkdir(retained, { mode: 0o700 });
    const file = join(retained, "store-bootstrap-diagnostics-v1.jsonl"); await writeFile(file, "invented retained fixture");
    const alias = join(root, "alias"); await symlink(retained, alias);
    const diagnostics = new StoreBootstrapDiagnostics(() => undefined);
    diagnostics.bindValidatedDirectory(alias); await diagnostics.failed();
    expect(await readFile(file, "utf8")).toBe("invented retained fixture");
    await chmod(retained, 0o755);
    const broad = new StoreBootstrapDiagnostics(() => undefined);
    broad.bindValidatedDirectory(retained); await broad.failed();
    expect(await readFile(file, "utf8")).toBe("invented retained fixture");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects a multiply linked journal without appending or repairing it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-bootstrap-")));
  try {
    const file = join(root, "store-bootstrap-diagnostics-v1.jsonl");
    await writeFile(file, "invented retained fixture", { mode: 0o600 }); await link(file, join(root, "second-link"));
    const diagnostics = new StoreBootstrapDiagnostics(() => undefined);
    diagnostics.bindValidatedDirectory(root); await diagnostics.failed();
    expect(await readFile(file, "utf8")).toBe("invented retained fixture");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not interrupt fail-close when the diagnostic stream fails", async () => {
  const diagnostics = new StoreBootstrapDiagnostics(() => { throw new Error("invented private fixture"); });
  await expect(diagnostics.failed()).resolves.toBeUndefined();
});

it("shares one failure write between the acquisition wrapper and outer catch", async () => {
  const lines: string[] = [], diagnostics = new StoreBootstrapDiagnostics(line => { lines.push(line); });
  const first = diagnostics.failed(), second = diagnostics.failed();
  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(lines).toEqual(["SCRIBE_STORE_BOOTSTRAP:1\n"]);
});

it("does not block fail-close on a private FIFO at the journal filename", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-bootstrap-")));
  try {
    const file = join(root, "store-bootstrap-diagnostics-v1.jsonl");
    execFileSync("/usr/bin/mkfifo", ["-m", "600", file], { timeout: 1000, stdio: "ignore" });
    const diagnostics = new StoreBootstrapDiagnostics(() => undefined);
    diagnostics.bindValidatedDirectory(root);
    await expect(diagnostics.failed()).resolves.toBeUndefined();
    expect((await lstat(file)).isFIFO()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("accepts only fragmented exact bridge categories and discards arbitrary stderr", () => {
  const reasons: number[] = [], decoder = new StoreBridgeDiagnosticDecoder(reason => { reasons.push(reason); });
  decoder.push(Buffer.from("invented private fixture\nSCRIBE_STORE_BRI"));
  decoder.push(Buffer.from("DGE:10\nSCRIBE_STORE_BRIDGE:15\nSCRIBE_STORE_BRIDGE:01\nSCRIBE_STORE_BRIDGE:11\n"));
  expect(reasons).toEqual([10, 11]);
});

it("accepts interrupted and termination categories while retaining only the first valid failure", async () => {
  for (const first of [13, 14]) {
    const lines: string[] = [], diagnostics = new StoreBootstrapDiagnostics(line => { lines.push(line); });
    const decoder = new StoreBridgeDiagnosticDecoder(reason => { diagnostics.observeBridge("store_bridge_failed", reason); });
    decoder.push(Buffer.from(`SCRIBE_STORE_BRIDGE:15\nSCRIBE_STORE_BRIDGE:${first}\nSCRIBE_STORE_BRIDGE:${first === 13 ? 14 : 13}\n`));
    await diagnostics.failed();
    expect(lines).toEqual(["SCRIBE_STORE_BOOTSTRAP:1\n", `SCRIBE_STORE_BRIDGE:${first}\n`]);
  }
});

it("bounds bridge bytes and events and never decodes non-ASCII as a fixed line", () => {
  const reasons: number[] = [], decoder = new StoreBridgeDiagnosticDecoder(reason => { reasons.push(reason); });
  decoder.push(Buffer.from("SCRIBE_STORE_BRIDGE:1\n".repeat(20)));
  expect(reasons).toHaveLength(16);
  const invalid: number[] = [], binary = new StoreBridgeDiagnosticDecoder(reason => { invalid.push(reason); });
  binary.push(Uint8Array.from([0xd3, ...Buffer.from("CRIBE_STORE_BRIDGE:1\n")]));
  binary.push(Buffer.from("SCRIBE_STORE_BRIDGE:1\n"));
  expect(invalid).toEqual([]);
  const large = new StoreBridgeDiagnosticDecoder(reason => { invalid.push(reason); });
  large.push(Buffer.alloc(1025, 65)); large.push(Buffer.from("SCRIBE_STORE_BRIDGE:1\n"));
  expect(invalid).toEqual([]);
});
