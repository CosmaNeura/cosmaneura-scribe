import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeProcessPCMDriver } from "./native-process-driver.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(waitForCancellation = false) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "scribe-permission-pipe-"));
  directories.push(directory);
  const helperPath = join(directory, "metadata-only-helper.cjs"), calls = join(directory, "calls.jsonl");
  const source = `#!${process.execPath}
const fs = require("node:fs");
const mode = process.argv[2];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(mode) + "\\n");
if (${waitForCancellation} && mode === "--request-permissions-v1") {
  setInterval(() => {}, 1000);
} else {
  const payload = Buffer.from(JSON.stringify({ type: "availability", available: mode === "--request-permissions-v1" }));
  const header = Buffer.alloc(5); header.writeUInt32BE(payload.length + 1); header[4] = 1;
  process.stdout.write(Buffer.concat([header, payload]));
}
`;
  await writeFile(helperPath, source, { mode: 0o500 });
  const authorize = vi.fn(async () => { throw new Error("Permission setup cannot authorize capture"); });
  const options = { enabled: true, helperPath, helperSha256: createHash("sha256").update(source).digest("hex"),
    isSessionActive: () => true, authorizeSelectedWindow: authorize };
  return { options, authorize, calls, driver: new NativeProcessPCMDriver(options) };
}

describe.skipIf(process.platform === "win32")("explicit native permission setup", () => {
  it("keeps ordinary probes read-only and launches only metadata setup on explicit request", async () => {
    const f = await fixture();
    expect(await f.driver.getAvailability()).toBe(false);
    expect(await f.driver.requestPermissions(new AbortController().signal)).toBe(true);
    expect((await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line) as unknown)).toEqual([
      "--availability-v1", "--request-permissions-v1",
    ]);
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("does not prompt when disabled, locked, revoked or the helper hash does not match", async () => {
    const f = await fixture(), revoked = new AbortController(); revoked.abort();
    expect(await f.driver.requestPermissions(revoked.signal)).toBe(false);
    for (const override of [{ enabled: false }, { isSessionActive: () => false }, { helperSha256: "0".repeat(64) }]) {
      const driver = new NativeProcessPCMDriver({ ...f.options, ...override });
      expect(await driver.requestPermissions(new AbortController().signal)).toBe(false);
    }
    await expect(readFile(f.calls)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("cancels only the non-recording setup process on revocation and retains no success", async () => {
    const f = await fixture(true), abort = new AbortController();
    const pending = f.driver.requestPermissions(abort.signal);
    try {
      await vi.waitFor(async () => expect(await readFile(f.calls, "utf8")).toContain("--request-permissions-v1"));
    } finally { abort.abort(); }
    expect(await pending).toBe(false);
    expect(f.authorize).not.toHaveBeenCalled();
  });
});
