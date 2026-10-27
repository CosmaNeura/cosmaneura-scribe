import { link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runtimeDiagnostics, type RuntimeDiagnostic } from "./runtime-diagnostics.js";

describe("local runtime diagnostics", () => {
  it.each(["provider_start_requested", "provider_resume_requested"] as const)("retains pre-native stages after exhausted budgets at %s", async boundary => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-pre-native-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (let i = 0; i < 128; i++) record("connect_begin");
      for (let i = 0; i < 32; i++) record("audio_stop_confirmed");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(160));
      // H6's native constructor was reached only after its old budget had
      // discarded the entire setup-renewal interval. These durations are synthetic.
      record(boundary); record("provider_preparation_metadata", 123.456); record("provider_source_prepare", 456.789);
      record("audio_start_pending"); record("audio_ready"); record("audio_stop_confirmed");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(166));
      const rows = (await readFile(path, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { event: string; capture_attempt: number; duration_ms?: number });
      expect(rows.slice(-6).map(row => row.event)).toEqual([boundary, "provider_preparation_metadata", "provider_source_prepare",
        "audio_start_pending", "audio_ready", "audio_stop_confirmed"]);
      expect(rows.slice(-6).map(row => row.capture_attempt)).toEqual([0, 0, 0, 1, 1, 1]);
      expect(rows.slice(-5, -3).map(row => row.duration_ms)).toEqual([123.456, 456.789]);
      expect((await stat(path)).size).toBeLessThanOrEqual(65_536);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("restores pre-native coverage with a full write queue without growing it or advancing the native attempt", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-pre-native-queue-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (let i = 0; i < 128; i++) record("connect_begin");
      for (let i = 0; i < 32; i++) record("audio_stop_confirmed");
      record("provider_resume_requested"); record("provider_source_prepare", 999);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(160));
      record("provider_source_prepare", 12); record("audio_start_pending"); record("audio_ready");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(163));
      const rows = (await readFile(path, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { event: string; capture_attempt: number; duration_ms?: number });
      expect(rows.slice(-3).map(row => [row.event, row.capture_attempt])).toEqual([
        ["provider_source_prepare", 0], ["audio_start_pending", 1], ["audio_ready", 1],
      ]);
      expect(rows.some(row => row.duration_ms === 999)).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("retains only closed Store bridge error categories through fourteen", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-store-bridge-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (const value of [0, 15, 1.5, NaN, Infinity, "private fixture" as unknown as number]) {
        record("store_bridge_failed", undefined, value);
      }
      record("store_bridge_failed", undefined, 13); record("store_bridge_failed", undefined, 14);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2));
      expect((await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>))
        .toEqual([13, 14].map(reason => ({ utc: expect.any(String), pid: process.pid, monotonic_ns: expect.any(String), capture_attempt: 0, event: "store_bridge_failed", reason_code: reason })));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("accepts fixed numeric failure reasons only on their corresponding events", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-failure-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (const value of [undefined, 0, 1.5, 13, NaN, Infinity, "private text" as unknown as number]) {
        record("audio_native_failure_reason", undefined, value);
      }
      record("audio_main_failure_reason", undefined, 16);
      record("audio_native_failure_reason", 1, 8);
      record("audio_failed", undefined, 8);
      record("audio_packet_sink", 120, 8);
      record("audio_native_failure_reason", undefined, 8);
      record("audio_main_failure_reason", undefined, 13);
      record("audio_packet_sink", 123.4567);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(3));
      expect((await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)).toEqual([
        { utc: expect.any(String), pid: process.pid, monotonic_ns: expect.any(String), capture_attempt: 0, event: "audio_native_failure_reason", reason_code: 8 },
        { utc: expect.any(String), pid: process.pid, monotonic_ns: expect.any(String), capture_attempt: 0, event: "audio_main_failure_reason", reason_code: 13 },
        { utc: expect.any(String), pid: process.pid, monotonic_ns: expect.any(String), capture_attempt: 0, event: "audio_packet_sink", duration_ms: 123.457 },
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("retains a separate bounded terminal allowance after routine events exhaust their budget", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-terminal-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (let i = 0; i < 129; i++) record("connect_begin");
      record("audio_main_failure_reason", undefined, 13);
      record("audio_failed"); record("audio_stop_confirmed");
      for (let i = 0; i < 30; i++) record("audio_chunk_commit_failed");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(160));
      const rows = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
      expect(rows.slice(128, 131).map(row => row.event)).toEqual(["audio_main_failure_reason", "audio_failed", "audio_stop_confirmed"]);
      expect(rows.filter(row => row.event === "audio_chunk_commit_failed")).toHaveLength(29);
      expect((await stat(path)).size).toBeLessThanOrEqual(65_536);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("records bounded input trigger and zero-valued workspace mismatch after routine exhaustion", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-input-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (let i = 0; i < 129; i++) record("connect_begin");
      for (const value of [undefined, 0, 6, 1.5, NaN, Infinity]) record("audio_input_change_trigger", undefined, value);
      for (const value of [undefined, -1, 256, 1.5, NaN, Infinity]) record("audio_input_change_mismatch", undefined, value);
      record("audio_input_change_trigger", undefined, 5);
      record("audio_input_change_mismatch", undefined, 0);
      record("audio_input_change_mismatch", undefined, 255);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(131));
      const rows = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
      expect(rows.slice(128).map(row => [row.event, row.reason_code])).toEqual([
        ["audio_input_change_trigger", 5], ["audio_input_change_mismatch", 0], ["audio_input_change_mismatch", 255],
      ]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("records window discovery outcomes as fixed events without window metadata", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-window-")));
    try {
      const events = ["meeting_windows_ready", "meeting_windows_empty", "meeting_windows_screen_access_denied",
        "meeting_windows_lookup_failed", "meeting_windows_limit_exceeded", "meeting_windows_unavailable",
        "meeting_windows_protocol_failed", "meeting_windows_transport_failed"] as const;
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (const event of events) record(event);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(events.length));
      (await readFile(path, "utf8")).trim().split("\n").forEach((line, index) => {
        expect(JSON.parse(line)).toEqual({ utc: expect.any(String), pid: process.pid, monotonic_ns: expect.any(String), capture_attempt: 0, event: events[index] });
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("records only fixed lifecycle metadata with private permissions and a bounded event count", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-diagnostic-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      record("invented sensitive input" as Parameters<RuntimeDiagnostic>[0]);
      for (let i = 0; i < 129; i++) record("connect_begin");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(128));
      for (const line of (await readFile(path, "utf8")).trim().split("\n")) {
        expect(JSON.parse(line)).toEqual({ utc: expect.any(String), pid: process.pid, monotonic_ns: expect.any(String), capture_attempt: 0, event: "connect_begin" });
      }
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("records a later capture attempt after routine and terminal budgets are exhausted", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-next-capture-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      for (let i = 0; i < 128; i++) record("connect_begin");
      for (let i = 0; i < 32; i++) record("audio_stop_confirmed");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(160));
      record("audio_start_pending"); record("audio_ready"); record("provider_record_to_native_ready", 250);
      record("audio_stop_confirmed");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(164));
      const rows = (await readFile(path, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { event: string; capture_attempt: number; monotonic_ns: string });
      expect(rows.slice(-4).map(row => row.event)).toEqual([
        "audio_start_pending", "audio_ready", "provider_record_to_native_ready", "audio_stop_confirmed",
      ]);
      expect(rows.slice(-4).every(row => row.capture_attempt === 1)).toBe(true);
      expect(rows.every((row, index) => index === 0 || BigInt(row.monotonic_ns) >= BigInt(rows[index - 1]!.monotonic_ns))).toBe(true);
      expect((await stat(path)).size).toBeLessThanOrEqual(65_536);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("resets attempt budgets even when the start event meets a full write queue", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-full-queue-")));
    try {
      const record = runtimeDiagnostics(directory), path = join(directory, "runtime-diagnostics-v1.jsonl");
      // All calls occur synchronously: none of the queued I/O can finish yet.
      for (let i = 0; i < 128; i++) record("connect_begin");
      for (let i = 0; i < 32; i++) record("audio_stop_confirmed");
      record("audio_start_pending");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(160));
      record("audio_ready"); record("provider_record_to_native_ready", 250); record("audio_stop_confirmed");
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(163));
      const rows = (await readFile(path, "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { event: string; capture_attempt: number });
      expect(rows.slice(-3).map(row => row.event)).toEqual([
        "audio_ready", "provider_record_to_native_ready", "audio_stop_confirmed",
      ]);
      expect(rows.slice(-3).every(row => row.capture_attempt === 1)).toBe(true);
      expect((await stat(path)).size).toBeLessThanOrEqual(65_536);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("does not follow a log symlink", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-diagnostic-")));
    try {
      const path = join(directory, "runtime-diagnostics-v1.jsonl"), target = join(directory, "untouched");
      await writeFile(target, "unchanged", { mode: 0o600 }); await symlink(target, path);
      runtimeDiagnostics(directory)("host_open");
      // Allow the asynchronous, best-effort write to settle before checking.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(target, "utf8")).toBe("unchanged");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps current startup timings when earlier launches have filled the private log", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-full-")));
    try {
      const path = join(directory, "runtime-diagnostics-v1.jsonl");
      const prior = JSON.stringify({ utc: "2026-10-07T00:00:00.000Z", pid: 1, event: "connect_begin" }) + "\n";
      const oldRecords = prior.repeat(Math.floor(65_536 / Buffer.byteLength(prior)));
      await writeFile(path, oldRecords, { mode: 0o600 });
      const record = runtimeDiagnostics(directory);
      record("host_open"); record("provider_recording_window", 7455.91);
      await vi.waitFor(async () => {
        const rows = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
        expect(rows.at(-1)).toMatchObject({ pid: process.pid, event: "provider_recording_window", duration_ms: 7455.91 });
        expect(rows.at(-2)).toMatchObject({ pid: process.pid, event: "host_open" });
        expect(rows.slice(0, -2).length).toBeGreaterThan(0);
        expect(rows.slice(0, -2).every(row => row.pid === 1 && row.event === "connect_begin")).toBe(true);
      });
      expect((await stat(path)).size).toBeLessThanOrEqual(65_536);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("leaves hard-linked, oversized and non-private files unchanged", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-runtime-refuse-")));
    try {
      const path = join(directory, "runtime-diagnostics-v1.jsonl"), target = join(directory, "retained");
      await writeFile(target, "unchanged", { mode: 0o600 }); await link(target, path);
      runtimeDiagnostics(directory)("host_open");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(target, "utf8")).toBe("unchanged");
      await rm(path); await writeFile(path, "x".repeat(65_537), { mode: 0o600 });
      runtimeDiagnostics(directory)("host_open");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await stat(path)).size).toBe(65_537);
      await rm(path); await writeFile(path, "unchanged", { mode: 0o644 });
      runtimeDiagnostics(directory)("host_open");
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(path, "utf8")).toBe("unchanged");
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
      record("provider_recorder_attach", 72.5);
      record("provider_recorder_prepare", 6274.81);
      record("provider_consent_to_ready", 6274.81);
      await vi.waitFor(async () => expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(8));
      const expected = [
        ["audio_availability_helper_check", 0], ["audio_availability_probe", 12.346],
        ["audio_permission_helper_check", 1], ["audio_permission_probe", 3_600_000], ["audio_capture_helper_check", 2],
        ["provider_recorder_attach", 72.5], ["provider_recorder_prepare", 6274.81],
        ["provider_consent_to_ready", 6274.81],
      ];
      (await readFile(path, "utf8")).trim().split("\n").forEach((line, index) => {
        expect(JSON.parse(line)).toEqual({ utc: expect.any(String), pid: process.pid, monotonic_ns: expect.any(String), capture_attempt: 0,
          event: expected[index]![0], duration_ms: expected[index]![1] });
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
