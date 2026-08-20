import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AcceptanceFailure,
  FUNCTION_ORIGIN,
  REPOSITORY_ROOT,
  SWA_ORIGIN,
  directDenial,
  formatGateEvent,
  readMode,
  readResponseBounded,
  runCli,
  safeFetch,
  sameOriginUrl,
  validateAttestation,
  validateLiveAuthorization,
} from "./acceptance.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("capture preview live acceptance runner", () => {
  it("resolves repository files from import.meta instead of a machine-specific path", () => {
    expect(REPOSITORY_ROOT).toBe(resolve(import.meta.dirname, "../../.."));
  });

  it("accepts only the fixed dry and SHA-pinned live command shapes", () => {
    expect(readMode([])).toEqual({ kind: "dry-run" });
    expect(readMode(["--dry-run"])).toEqual({ kind: "dry-run" });
    expect(readMode(["--execute-live", "--expected-sha", SHA])).toEqual({
      kind: "execute-live",
      expectedSha: SHA,
    });
    for (const invalid of [
      ["--execute-live"],
      ["--execute-live", SHA],
      ["--execute-live", "--expected-sha", SHA.toUpperCase()],
      ["--execute-live", "--expected-sha", `${SHA}0`],
      ["--execute-live", "--expected-sha", SHA, "https://custom.invalid"],
      ["--dry-run", "--expected-sha", SHA],
    ]) {
      expect(() => readMode(invalid)).toThrowError("arguments_invalid");
    }
  });

  it("requires an explicit synthetic-only authorization and exact env/argument SHA match", () => {
    const mode = readMode(["--execute-live", "--expected-sha", SHA]);
    expect(() => validateLiveAuthorization(mode, {
      CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED: "synthetic-only",
      CAPTURE_PREVIEW_DEPLOYED_SHA: SHA,
      CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN: SWA_ORIGIN,
      CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN: FUNCTION_ORIGIN,
    })).not.toThrow();
    expect(() => validateLiveAuthorization(mode, {
      CAPTURE_PREVIEW_DEPLOYED_SHA: SHA,
      CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN: SWA_ORIGIN,
      CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN: FUNCTION_ORIGIN,
    })).toThrowError("live_authorization_missing");
    expect(() => validateLiveAuthorization(mode, {
      CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED: "synthetic-only",
      CAPTURE_PREVIEW_DEPLOYED_SHA: "f".repeat(40),
      CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN: SWA_ORIGIN,
      CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN: FUNCTION_ORIGIN,
    })).toThrowError("deployed_sha_not_pinned");
    expect(() => validateLiveAuthorization(mode, {
      CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED: "synthetic-only",
      CAPTURE_PREVIEW_DEPLOYED_SHA: SHA,
      CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN: "https://wrong.example.invalid",
      CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN: FUNCTION_ORIGIN,
    })).toThrowError("swa_origin_not_pinned");
    expect(() => validateLiveAuthorization(mode, {
      CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED: "synthetic-only",
      CAPTURE_PREVIEW_DEPLOYED_SHA: SHA,
      CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN: SWA_ORIGIN,
      CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN: "https://wrong.example.invalid",
    })).toThrowError("function_origin_not_pinned");
  });

  it("locks both deployment attestations to an exact schema and source SHA", () => {
    const valid = {
      schema_version: 1,
      source_sha: SHA,
      mode: "synthetic",
      microphone_enabled: false,
    };
    expect(() => validateAttestation(valid, SHA)).not.toThrow();
    expect(() => validateAttestation({ ...valid, source_sha: "f".repeat(40) }, SHA))
      .toThrowError("deployment_attestation_sha_invalid");
    expect(() => validateAttestation({ ...valid, microphone_enabled: true }, SHA))
      .toThrowError("deployment_attestation_microphone_invalid");
    expect(() => validateAttestation({ ...valid, extra: true }, SHA))
      .toThrowError("deployment_attestation_shape_invalid");
  });

  it("constructs requests only against the fixed SWA origin without query or fragment input", () => {
    expect(sameOriginUrl("/api/capture/preview/health").href)
      .toBe(`${SWA_ORIGIN}/api/capture/preview/health`);
    for (const invalid of [
      "https://wrong.example.invalid/api/capture/preview/health",
      "//wrong.example.invalid/path",
      "/path?custom=true",
      "/path#fragment",
      "path",
    ]) {
      expect(() => sameOriginUrl(invalid)).toThrow(AcceptanceFailure);
    }
  });

  it("streams bounded responses and cancels immediately after the cap is crossed", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel: cancelled,
    }));
    await expect(readResponseBounded(response, 4, "bounded"))
      .rejects.toThrowError("bounded_response_too_large");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("combines a bounded streamed response without relying on arrayBuffer", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    }));
    await expect(readResponseBounded(response, 3, "bounded_ok"))
      .resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects an oversized declared response before reading and cancels its body", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { "Content-Length": "12" },
    });
    await expect(readResponseBounded(response, 11, "declared"))
      .rejects.toThrowError("declared_response_too_large");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("passes a per-request abort signal and fails closed when its timeout expires", async () => {
    const fetchImplementation = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    await expect(safeFetch("timeout_probe", new URL(`${SWA_ORIGIN}/`), { method: "GET" }, {
      fetchImplementation,
      timeoutMs: 5,
    })).rejects.toThrowError("timeout_probe_network_failed");
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("requires the exact AuthV2 401 instead of accepting an application-level 403", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 401 }));
      await expect(directDenial(new AbortController().signal)).resolves.toBeUndefined();

      globalThis.fetch = vi.fn(async () => new Response(null, { status: 403 }));
      await expect(directDenial(new AbortController().signal))
        .rejects.toThrowError("direct_health_not_denied");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("distinguishes the global deadline from an individual request failure", async () => {
    const globalController = new AbortController();
    globalController.abort();
    await expect(safeFetch("deadline_probe", new URL(`${SWA_ORIGIN}/`), { method: "GET" }, {
      globalSignal: globalController.signal,
      fetchImplementation: vi.fn(),
    })).rejects.toThrowError("global_deadline_exceeded");
  });

  it("emits only fixed allowlisted metadata", () => {
    expect(formatGateEvent("deployment_attestation")).toBe(
      '{"gate":"deployment_attestation","status":"passed"}\n',
    );
    expect(() => formatGateEvent(SHA)).toThrowError("output_gate_invalid");
  });

  it("performs the dry self-review without network access", async () => {
    const output = { write: vi.fn() };
    const errorOutput = { write: vi.fn() };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => {
      throw new Error("network must remain disabled");
    });
    try {
      await expect(runCli(["--dry-run"], {}, output, errorOutput)).resolves.toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(output.write).toHaveBeenCalledWith(
      '{"gate":"acceptance_dry_validation","status":"passed"}\n',
    );
    expect(errorOutput.write).not.toHaveBeenCalled();
  });

  it("returns a fixed failure line without echoing rejected command input", async () => {
    const output = { write: vi.fn() };
    const errorOutput = { write: vi.fn() };
    await expect(runCli(["--unknown", "sensitive-value"], {}, output, errorOutput)).resolves.toBe(1);
    expect(output.write).not.toHaveBeenCalled();
    expect(errorOutput.write).toHaveBeenCalledWith(
      "capture_preview_acceptance_failed:arguments_invalid\n",
    );
  });
});
