import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runtimeDiagnostics, type RuntimeDiagnostic } from "./runtime-diagnostics.js";

describe("local runtime diagnostics", () => {
  it("records only fixed lifecycle metadata with private permissions and a bounded event count", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-diagnostic-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      record("invented sensitive input" as Parameters<RuntimeDiagnostic>[0]);
      for (let i = 0; i < 129; i++) record("connect_begin");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(128));
      for (const line of (await readFile(path, "utf8")).trim().split("\n")) {
        expect(JSON.parse(line)).toEqual({ utc: expect.any(String), pid: process.pid, event: "connect_begin" });
      }
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("does not follow a log symlink or grow a full diagnostic file", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-diagnostic-")));
    try {
      const path = join(directory, "runtime-diagnostics-v1.jsonl"), target = join(directory, "untouched");
      await writeFile(target, "unchanged", { mode: 0o600 }); await symlink(target, path);
      runtimeDiagnostics(directory)("host_open");
      // Allow the asynchronous, best-effort write to settle before checking.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(target, "utf8")).toBe("unchanged");
      await rm(path); await writeFile(path, "x".repeat(65_536), { mode: 0o600 });
      runtimeDiagnostics(directory)("host_open");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await stat(path)).size).toBe(65_536);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("accepts bounded numeric phase durations only for fixed timing events", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-timing-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (const value of [undefined, NaN, Infinity, -1, 3_600_001, "private text" as unknown as number]) {
        record("audio_availability_probe", value);
      }
      record("host_open", 1);
      record("invented private timing" as Parameters<RuntimeDiagnostic>[0], 12);
      record("audio_availability_helper_check", 0);
      record("audio_availability_probe", 12.34567);
      record("audio_permission_helper_check", 1);
      record("audio_permission_probe", 3_600_000);
      record("audio_capture_helper_check", 2);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(5));
      const expected = [
        ["audio_availability_helper_check", 0], ["audio_availability_probe", 12.346],
        ["audio_permission_helper_check", 1], ["audio_permission_probe", 3_600_000], ["audio_capture_helper_check", 2],
      ];
      (await readFile(path, "utf8")).trim().split("\n").forEach((line, index) => {
        expect(JSON.parse(line)).toEqual({ utc: expect.any(String), pid: process.pid,
          event: expected[index]![0], duration_ms: expected[index]![1] });
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
