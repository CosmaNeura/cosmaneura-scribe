import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
export const SWA_ORIGIN = "https://green-rock-0cd7d7e0f.7.azurestaticapps.net";
export const FUNCTION_ORIGIN = "https://cmn-cap-prev-api-p8x6m2.azurewebsites.net";

const COOKIE_NAME = "__Host-capture_preview";
const REQUEST_TIMEOUT_MS = 30_000;
const GLOBAL_DEADLINE_MS = 240_000;
const MAX_JSON_RESPONSE_BYTES = 131_072;
const ROOT_RESPONSE_LIMIT_BYTES = 1_048_576;
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OUTPUT_GATES = new Set([
  "acceptance_dry_validation",
  "bootstrap_public_key",
  "capture_preview_live_acceptance",
  "deployment_attestation",
  "direct_hard_denial",
  "full_synthetic_capture_flow",
  "idempotency_scope_isolation_negatives",
  "negative_envelope_guards",
  "swa_headers_health",
]);

export class AcceptanceFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "AcceptanceFailure";
    this.code = code;
  }
}

class MemoryCookieJar {
  #cookie = null;

  capture(setCookie) {
    fixed(typeof setCookie === "string", "bootstrap_cookie_missing");
    const parts = setCookie.split(";").map((part) => part.trim());
    const first = parts.shift() ?? "";
    const separator = first.indexOf("=");
    fixed(separator > 0, "bootstrap_cookie_invalid");
    const name = first.slice(0, separator);
    const value = first.slice(separator + 1);
    fixed(name === COOKIE_NAME, "bootstrap_cookie_name_invalid");
    fixed(/^[A-Za-z0-9_-]{43}$/u.test(value), "bootstrap_cookie_value_invalid");
    const attributes = new Map();
    for (const part of parts) {
      const key = part.split("=", 1)[0]?.toLowerCase() ?? "";
      fixed(key !== "" && !attributes.has(key), "bootstrap_cookie_attribute_duplicate");
      attributes.set(key, part.toLowerCase());
    }
    fixed(attributes.size === 5, "bootstrap_cookie_attributes_invalid");
    fixed(attributes.get("path") === "path=/", "bootstrap_cookie_path_invalid");
    fixed(attributes.get("max-age") === "max-age=86400", "bootstrap_cookie_age_invalid");
    fixed(attributes.get("secure") === "secure", "bootstrap_cookie_secure_missing");
    fixed(attributes.get("httponly") === "httponly", "bootstrap_cookie_http_only_missing");
    fixed(attributes.get("samesite") === "samesite=strict", "bootstrap_cookie_same_site_invalid");
    fixed(!attributes.has("domain"), "bootstrap_cookie_domain_present");
    this.#cookie = `${name}=${value}`;
  }

  header() {
    fixed(this.#cookie !== null, "cookie_jar_empty");
    return this.#cookie;
  }

  differsFrom(other) {
    return this.#cookie !== null && other.#cookie !== null && this.#cookie !== other.#cookie;
  }

  clear() {
    this.#cookie = null;
  }
}

export async function runCli(
  arguments_ = process.argv.slice(2),
  environment = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
) {
  try {
    await main(arguments_, environment, output);
    return 0;
  } catch (error) {
    const code = error instanceof AcceptanceFailure ? error.code : "unexpected_failure";
    errorOutput.write(`capture_preview_acceptance_failed:${code}\n`);
    return 1;
  }
}

async function main(arguments_, environment, output) {
  const mode = readMode(arguments_);
  const protocol = await importLocal("packages/capture-protocol/src/generated.ts");
  const wav = await importLocal("apps/capture/src/capture/wav.ts");
  const previewDomain = await importLocal("packages/capture-preview-domain/src/constants.ts");
  const staticHeaders = await readPinnedStaticHeaders();
  validateImportedHelpers(protocol, wav, previewDomain);

  if (mode.kind === "dry-run") {
    await dryValidation(protocol, wav, previewDomain);
    emit(output, "acceptance_dry_validation");
    return;
  }

  validateLiveAuthorization(mode, environment);
  fixed(process.versions.node === "24.5.0", "live_node_version_invalid");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), GLOBAL_DEADLINE_MS);
  deadline.unref?.();
  try {
    await liveAcceptance({
      protocol,
      wav,
      previewDomain,
      staticHeaders,
      expectedSha: mode.expectedSha,
      signal: controller.signal,
      output,
    });
  } finally {
    clearTimeout(deadline);
  }
}

export function readMode(arguments_) {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === "--dry-run")) {
    return Object.freeze({ kind: "dry-run" });
  }
  if (
    arguments_.length === 3 &&
    arguments_[0] === "--execute-live" &&
    arguments_[1] === "--expected-sha" &&
    typeof arguments_[2] === "string" &&
    SHA1.test(arguments_[2])
  ) {
    return Object.freeze({ kind: "execute-live", expectedSha: arguments_[2] });
  }
  throw new AcceptanceFailure("arguments_invalid");
}

export function validateLiveAuthorization(mode, environment) {
  fixed(mode.kind === "execute-live" && SHA1.test(mode.expectedSha), "deployed_sha_not_pinned");
  fixed(
    environment.CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED === "synthetic-only",
    "live_authorization_missing",
  );
  fixed(
    typeof environment.CAPTURE_PREVIEW_DEPLOYED_SHA === "string" &&
      SHA1.test(environment.CAPTURE_PREVIEW_DEPLOYED_SHA) &&
      environment.CAPTURE_PREVIEW_DEPLOYED_SHA === mode.expectedSha,
    "deployed_sha_not_pinned",
  );
  fixed(
    environment.CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN === SWA_ORIGIN,
    "swa_origin_not_pinned",
  );
  fixed(
    environment.CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN === FUNCTION_ORIGIN,
    "function_origin_not_pinned",
  );
}

async function importLocal(relativePath) {
  const path = resolve(REPOSITORY_ROOT, relativePath);
  fixed(path.startsWith(`${REPOSITORY_ROOT}/`), "local_import_invalid");
  try {
    return await import(pathToFileURL(path).href);
  } catch {
    throw new AcceptanceFailure("local_import_failed");
  }
}

async function readPinnedStaticHeaders() {
  const path = resolve(REPOSITORY_ROOT, "apps/capture/public/staticwebapp.config.json");
  try {
    const raw = await readFile(path, "utf8");
    fixed(Buffer.byteLength(raw, "utf8") <= 65_536, "static_policy_too_large");
    const parsed = JSON.parse(raw);
    fixed(isRecord(parsed) && isRecord(parsed.globalHeaders), "static_policy_invalid");
    exactKeys(parsed.globalHeaders, [
      "Content-Security-Policy",
      "Cross-Origin-Opener-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "X-Content-Type-Options",
    ], "static_policy");
    for (const value of Object.values(parsed.globalHeaders)) {
      fixed(typeof value === "string" && value.length > 0, "static_policy_invalid");
    }
    return Object.freeze({ ...parsed.globalHeaders });
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    throw new AcceptanceFailure("static_policy_read_failed");
  }
}

function validateImportedHelpers(protocol, wav, previewDomain) {
  for (const value of [protocol.PROTOCOL_VERSION, protocol.CONTENT_ENCRYPTION, protocol.MEDIA_TYPE]) {
    fixed(typeof value === "string" && value.length > 0, "protocol_import_invalid");
  }
  for (const value of [
    protocol.NONCE_BYTES,
    protocol.MAX_ENVELOPE_BYTES,
    protocol.TARGET_CHUNK_DURATION_MS,
    protocol.CAPTURE_LEASE_TTL_SECONDS,
    protocol.RESERVATION_WINDOW_SECONDS,
    protocol.UPLOAD_CONCURRENCY,
    protocol.RESERVATION_PLAINTEXT_BUDGET_BYTES,
    protocol.SAMPLE_RATE_HZ,
    protocol.AUDIO_CHANNELS,
    previewDomain.HOSTED_MAX_CHUNKS,
  ]) {
    fixed(Number.isSafeInteger(value) && value > 0, "protocol_import_invalid");
  }
  for (const helper of [
    protocol.base64UrlDecode,
    protocol.base64UrlEncode,
    protocol.encodeEnvelope,
    protocol.parseEnvelope,
    wav.pcm16WavProfile,
    wav.targetFrameCount,
    wav.encodePcm16MonoWav,
  ]) {
    fixed(typeof helper === "function", "protocol_helper_missing");
  }
  fixed(
    isRecord(previewDomain.SYNTHETIC_PUBLIC_KEY) &&
      previewDomain.SYNTHETIC_PUBLIC_KEY.key_version === "synthetic-wrapping-key-v1",
    "preview_key_import_invalid",
  );
}

async function dryValidation(protocol, wav, previewDomain) {
  const plannedPaths = new Set([
    "/capture-preview-deployment.json",
    "/api/capture/preview/deployment",
    "/api/capture/preview/health",
    "/api/capture/preview/bootstrap",
    "/api/capture/audio-encryption-key",
    "/api/capture/consents",
    "/api/capture/sessions",
    "/api/capture/sessions/{session}/audio-key",
    "/api/capture/sessions/{session}/capture-capabilities",
    "/api/capture/sessions/{session}/capture-lease",
    "/api/capture/sessions/{session}/chunk-reservations",
    "/api/capture/sessions/{session}/chunks/{object}/upload-authorization",
    "/api/capture/preview/uploads/{scope}/{object}",
    "/api/capture/sessions/{session}/chunks",
    "/api/capture/sessions/{session}/chunks/{object}",
    "/api/capture/sessions/{session}/capture-complete",
    "/api/capture/sessions/{session}/transcription-status",
    "/api/capture/sessions/{session}/transcript",
  ]);
  fixed(plannedPaths.size === 18, "route_plan_invalid");
  const capabilities = syntheticCapabilities(protocol, previewDomain.HOSTED_MAX_CHUNKS);
  const profile = wav.pcm16WavProfile(capabilities);
  fixed(wav.targetFrameCount(profile) > 0, "wav_profile_invalid");
  const nonce = new Uint8Array(protocol.NONCE_BYTES);
  const ciphertext = new Uint8Array(16);
  const envelope = protocol.encodeEnvelope({
    schema_version: protocol.PROTOCOL_VERSION,
    content_encryption: protocol.CONTENT_ENCRYPTION,
    nonce: protocol.base64UrlEncode(nonce),
    media_type: protocol.MEDIA_TYPE,
  }, ciphertext);
  const parsed = protocol.parseEnvelope(envelope);
  fixed(parsed.header.schema_version === protocol.PROTOCOL_VERSION, "envelope_round_trip_failed");
  nonce.fill(0);
  ciphertext.fill(0);
  parsed.ciphertext.fill(0);
  envelope.fill(0);
}

function syntheticCapabilities(protocol, hostedMaxChunks) {
  return {
    protocol_version: protocol.PROTOCOL_VERSION,
    media: {
      media_type: protocol.MEDIA_TYPE,
      encoding: protocol.AUDIO_ENCODING,
      channels: protocol.AUDIO_CHANNELS,
      sample_rate_hz: protocol.SAMPLE_RATE_HZ,
    },
    target_chunk_duration_ms: protocol.TARGET_CHUNK_DURATION_MS,
    max_envelope_bytes: protocol.MAX_ENVELOPE_BYTES,
    max_chunks: hostedMaxChunks,
    remaining_aggregate_plaintext_bytes:
      hostedMaxChunks * protocol.RESERVATION_PLAINTEXT_BUDGET_BYTES,
    capture_lease_ttl_seconds: protocol.CAPTURE_LEASE_TTL_SECONDS,
    reservation_window_seconds: protocol.RESERVATION_WINDOW_SECONDS,
    max_reservations_per_batch: hostedMaxChunks,
    upload_concurrency: protocol.UPLOAD_CONCURRENCY,
  };
}

async function liveAcceptance(context) {
  await directDenial(context.signal);
  emit(context.output, "direct_hard_denial");
  await deploymentAttestation(context.expectedSha, context.signal);
  emit(context.output, "deployment_attestation");
  await swaReadOnlyPolicy(context.staticHeaders, context.signal);
  emit(context.output, "swa_headers_health");

  const jarA = new MemoryCookieJar();
  const jarB = new MemoryCookieJar();
  let sensitive = null;
  try {
    const unauthenticated = await jsonCall(context.signal, {
      label: "unauthenticated_key",
      method: "GET",
      path: "/api/capture/audio-encryption-key",
    });
    expectError(unauthenticated, 401, "preview_bootstrap_required", "unauthenticated_key");

    const wrongOriginBootstrap = await jsonCall(context.signal, {
      label: "wrong_origin_bootstrap",
      method: "POST",
      path: "/api/capture/preview/bootstrap",
      origin: "https://wrong.example.invalid",
    });
    expectError(wrongOriginBootstrap, 403, "preview_origin_rejected", "wrong_origin_bootstrap");

    await bootstrap(jarA, "bootstrap_a", context.previewDomain.HOSTED_MAX_CHUNKS, context.signal);
    await bootstrap(jarB, "bootstrap_b", context.previewDomain.HOSTED_MAX_CHUNKS, context.signal);
    fixed(jarA.differsFrom(jarB), "scope_cookie_isolation_failed");
    const keyBody = await publicKey(jarA, context.previewDomain.SYNTHETIC_PUBLIC_KEY, context.signal);
    emit(context.output, "bootstrap_public_key");

    await requestNegatives(jarB, context.signal);

    const consentRequest = validConsent("2026-08-20T00:00:00.000Z");
    const consentFirst = await jsonCall(context.signal, {
      label: "consent_a",
      method: "POST",
      path: "/api/capture/consents",
      jar: jarA,
      jsonBody: consentRequest,
      idempotencyKey: "acceptance-a-consent-v1-0001",
    });
    expectStatus(consentFirst, 201, "consent_a");
    const consentAId = requiredUuid(consentFirst.body, "id", "consent_a");
    const consentReplay = await jsonCall(context.signal, {
      label: "consent_a_replay",
      method: "POST",
      path: "/api/capture/consents",
      jar: jarA,
      jsonBody: consentRequest,
      idempotencyKey: "acceptance-a-consent-v1-0001",
    });
    expectStatus(consentReplay, 201, "consent_a_replay");
    fixed(equalJson(consentReplay.body, consentFirst.body), "consent_replay_changed");
    const consentConflict = await jsonCall(context.signal, {
      label: "consent_a_conflict",
      method: "POST",
      path: "/api/capture/consents",
      jar: jarA,
      jsonBody: validConsent("2026-08-20T00:00:01.000Z"),
      idempotencyKey: "acceptance-a-consent-v1-0001",
    });
    expectError(consentConflict, 409, "idempotency_conflict", "consent_a_conflict");

    const sessionRequestA = validSession(consentAId);
    const sessionsA = await Promise.all([
      jsonCall(context.signal, {
        label: "session_a_concurrent_one",
        method: "POST",
        path: "/api/capture/sessions",
        jar: jarA,
        jsonBody: sessionRequestA,
        idempotencyKey: "acceptance-a-session-v1-0001",
      }),
      jsonCall(context.signal, {
        label: "session_a_concurrent_two",
        method: "POST",
        path: "/api/capture/sessions",
        jar: jarA,
        jsonBody: sessionRequestA,
        idempotencyKey: "acceptance-a-session-v1-0001",
      }),
    ]);
    for (const result of sessionsA) expectStatus(result, 201, "session_a_concurrent");
    fixed(equalJson(sessionsA[0].body, sessionsA[1].body), "session_concurrent_replay_changed");
    const sessionAId = requiredUuid(sessionsA[0].body, "id", "session_a");

    const consentB = await jsonCall(context.signal, {
      label: "consent_b",
      method: "POST",
      path: "/api/capture/consents",
      jar: jarB,
      jsonBody: consentRequest,
      idempotencyKey: "acceptance-b-consent-v1-0001",
    });
    expectStatus(consentB, 201, "consent_b");
    const consentBId = requiredUuid(consentB.body, "id", "consent_b");
    const sessionB = await jsonCall(context.signal, {
      label: "session_b",
      method: "POST",
      path: "/api/capture/sessions",
      jar: jarB,
      jsonBody: validSession(consentBId),
      idempotencyKey: "acceptance-b-session-v1-0001",
    });
    expectStatus(sessionB, 201, "session_b");
    const sessionBId = requiredUuid(sessionB.body, "id", "session_b");

    const crossA = await jsonCall(context.signal, {
      label: "scope_a_reads_b",
      method: "GET",
      path: `/api/capture/sessions/${sessionBId}/capture-capabilities`,
      jar: jarA,
    });
    expectError(crossA, 404, "session_not_found", "scope_a_reads_b");
    const crossB = await jsonCall(context.signal, {
      label: "scope_b_reads_a",
      method: "GET",
      path: `/api/capture/sessions/${sessionAId}/capture-capabilities`,
      jar: jarB,
    });
    expectError(crossB, 404, "session_not_found", "scope_b_reads_a");
    emit(context.output, "idempotency_scope_isolation_negatives");

    sensitive = await completeSyntheticFlow({
      jar: jarA,
      sessionId: sessionAId,
      publicKeyBody: keyBody,
      protocol: context.protocol,
      wav: context.wav,
      hostedMaxChunks: context.previewDomain.HOSTED_MAX_CHUNKS,
      signal: context.signal,
      output: context.output,
    });
    emit(context.output, "full_synthetic_capture_flow");
  } finally {
    sensitive?.clear();
    jarA.clear();
    jarB.clear();
  }
  emit(context.output, "capture_preview_live_acceptance");
}

export async function directDenial(signal) {
  const response = await safeFetch(
    "direct_health",
    `${FUNCTION_ORIGIN}/api/capture/preview/health`,
    { method: "GET", redirect: "manual", cache: "no-store" },
    { globalSignal: signal },
  );
  fixed(response.status === 401, "direct_health_not_denied");
  fixed(!response.headers.has("location"), "direct_health_redirected");
  await discardBounded(response, MAX_JSON_RESPONSE_BYTES, "direct_health");
}

async function deploymentAttestation(expectedSha, signal) {
  const staticResult = await jsonResource(signal, "static_attestation", "/capture-preview-deployment.json");
  const functionResult = await jsonResource(signal, "function_attestation", "/api/capture/preview/deployment");
  for (const [label, result] of [["static_attestation", staticResult], ["function_attestation", functionResult]]) {
    fixed(result.response.status === 200, `${label}_status_invalid`);
    requireNoStore(result.response, label);
    validateAttestation(result.body, expectedSha, label);
  }
  fixed(equalJson(staticResult.body, functionResult.body), "deployment_attestation_mismatch");
}

export function validateAttestation(value, expectedSha, label = "deployment_attestation") {
  fixed(SHA1.test(expectedSha), `${label}_sha_invalid`);
  exactKeys(value, ["microphone_enabled", "mode", "schema_version", "source_sha"], label);
  fixed(value.schema_version === 1, `${label}_schema_invalid`);
  fixed(value.source_sha === expectedSha, `${label}_sha_invalid`);
  fixed(value.mode === "synthetic", `${label}_mode_invalid`);
  fixed(value.microphone_enabled === false, `${label}_microphone_invalid`);
}

async function jsonResource(signal, label, path) {
  const response = await safeFetch(label, sameOriginUrl(path), {
    method: "GET",
    redirect: "error",
    cache: "no-store",
  }, { globalSignal: signal });
  requireJsonContentType(response, label);
  return { response, body: await readBoundedJson(response, label) };
}

async function swaReadOnlyPolicy(staticHeaders, signal) {
  const root = await safeFetch("swa_root", `${SWA_ORIGIN}/`, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
  }, { globalSignal: signal });
  fixed(root.status === 200, "swa_root_status_invalid");
  for (const [name, expected] of Object.entries(staticHeaders)) {
    fixed(root.headers.get(name) === expected, "swa_static_policy_mismatch");
  }
  await discardBounded(root, ROOT_RESPONSE_LIMIT_BYTES, "swa_root");

  const health = await jsonCall(signal, {
    label: "swa_health",
    method: "GET",
    path: "/api/capture/preview/health",
  });
  expectStatus(health, 200, "swa_health");
  exactKeys(health.body, ["mode", "status"], "swa_health");
  fixed(health.body.mode === "synthetic" && health.body.status === "ok", "swa_health_body_invalid");
}

async function bootstrap(jar, label, hostedMaxChunks, signal) {
  const result = await jsonCall(signal, { label, method: "POST", path: "/api/capture/preview/bootstrap" });
  expectStatus(result, 200, label);
  exactKeys(result.body, ["max_chunks", "microphone_enabled", "mode"], label);
  fixed(result.body.mode === "synthetic", "bootstrap_mode_invalid");
  fixed(result.body.microphone_enabled === false, "bootstrap_microphone_enabled");
  fixed(result.body.max_chunks === hostedMaxChunks, "bootstrap_chunk_limit_invalid");
  jar.capture(result.response.headers.get("set-cookie"));
}

async function publicKey(jar, expectedKey, signal) {
  const result = await jsonCall(signal, {
    label: "public_key",
    method: "GET",
    path: "/api/capture/audio-encryption-key",
    jar,
  });
  expectStatus(result, 200, "public_key");
  fixed(equalJson(result.body, expectedKey), "public_key_not_repo_pinned");
  exactKeys(result.body, ["algorithm", "key_version", "public_jwk"], "public_key");
  fixed(result.body.algorithm === "RSA-OAEP-256", "public_key_algorithm_invalid");
  fixed(result.body.key_version === "synthetic-wrapping-key-v1", "public_key_version_invalid");
  const jwk = result.body.public_jwk;
  exactKeys(jwk, ["alg", "e", "ext", "key_ops", "kty", "n"], "public_jwk");
  fixed(jwk.kty === "RSA" && jwk.alg === "RSA-OAEP-256", "public_jwk_type_invalid");
  fixed(jwk.e === "AQAB" && jwk.ext === true, "public_jwk_parameters_invalid");
  fixed(Array.isArray(jwk.key_ops) && equalJson(jwk.key_ops, ["wrapKey"]), "public_jwk_ops_invalid");
  fixed(typeof jwk.n === "string" && canonicalBase64UrlBytes(jwk.n).byteLength === 384, "public_jwk_modulus_invalid");
  return result.body;
}

async function requestNegatives(jar, signal) {
  const malformed = await jsonCall(signal, {
    label: "malformed_json",
    method: "POST",
    path: "/api/capture/consents",
    jar,
    rawBody: new TextEncoder().encode("{"),
    contentType: "application/json",
    idempotencyKey: "acceptance-b-malformed-v1",
  });
  expectError(malformed, 400, "invalid_json", "malformed_json");

  const nonSynthetic = await jsonCall(signal, {
    label: "non_synthetic_consent",
    method: "POST",
    path: "/api/capture/consents",
    jar,
    jsonBody: { ...validConsent("2026-08-20T00:00:00.000Z"), appointment_id: "non-synthetic-appointment" },
    idempotencyKey: "acceptance-b-non-synthetic-v1",
  });
  expectError(nonSynthetic, 422, "synthetic_input_required", "non_synthetic_consent");
}

async function completeSyntheticFlow({ jar, sessionId, publicKeyBody, protocol, wav, hostedMaxChunks, signal, output }) {
  let wavBytes = null;
  let additionalData = null;
  let nonce = null;
  let ciphertext = null;
  let envelope = null;
  let parsedCiphertext = null;
  let oversizedEnvelope = null;
  try {
    const rsaKey = await crypto.subtle.importKey(
      "jwk",
      publicKeyBody.public_jwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["wrapKey"],
    );
    const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dek, rsaKey, "RSA-OAEP"));
    const wrappedDek = protocol.base64UrlEncode(wrapped);
    wrapped.fill(0);
    fixed(wrappedDek.length === 512, "wrapped_dek_invalid");

    const bound = await jsonCall(signal, {
      label: "bind_audio_key",
      method: "POST",
      path: `/api/capture/sessions/${sessionId}/audio-key`,
      jar,
      jsonBody: { key_version: publicKeyBody.key_version, wrapped_dek: wrappedDek },
      idempotencyKey: "acceptance-a-bind-v1-0001",
    });
    expectStatus(bound, 201, "bind_audio_key");

    const capabilitiesResult = await jsonCall(signal, {
      label: "capture_capabilities",
      method: "GET",
      path: `/api/capture/sessions/${sessionId}/capture-capabilities`,
      jar,
    });
    expectStatus(capabilitiesResult, 200, "capture_capabilities");
    const capabilities = capabilitiesResult.body;
    validateCapabilities(capabilities, protocol, hostedMaxChunks);

    const lease = await jsonCall(signal, {
      label: "capture_lease",
      method: "POST",
      path: `/api/capture/sessions/${sessionId}/capture-lease`,
      jar,
      jsonBody: { protocol_version: protocol.PROTOCOL_VERSION },
      idempotencyKey: "acceptance-a-lease-v1-0001",
    });
    expectStatus(lease, 201, "capture_lease");
    const leaseId = requiredUuid(lease.body, "lease_id", "capture_lease");
    const generation = requiredInteger(lease.body, "generation", 1, "capture_lease");

    const batch = await jsonCall(signal, {
      label: "chunk_reservation",
      method: "POST",
      path: `/api/capture/sessions/${sessionId}/chunk-reservations`,
      jar,
      jsonBody: {
        protocol_version: protocol.PROTOCOL_VERSION,
        capture_lease_id: leaseId,
        capture_lease_generation: generation,
        channel: "microphone",
        first_sequence_number: 0,
        count: 1,
      },
      idempotencyKey: "acceptance-a-reserve-v1-0001",
    });
    expectStatus(batch, 201, "chunk_reservation");
    fixed(Array.isArray(batch.body.reservations) && batch.body.reservations.length === 1, "reservation_count_invalid");
    const reservation = batch.body.reservations[0];
    const objectId = requiredUuid(reservation, "object_id", "chunk_reservation");
    fixed(reservation.session_id === sessionId, "reservation_session_invalid");
    fixed(reservation.channel === "microphone" && reservation.sequence_number === 0, "reservation_position_invalid");
    fixed(typeof reservation.additional_authenticated_data === "string", "reservation_aad_missing");
    additionalData = canonicalBase64UrlBytes(reservation.additional_authenticated_data);
    validateAdditionalData(additionalData, sessionId, objectId);

    const authorizationRequest = {
      label: "upload_authorization",
      method: "POST",
      path: `/api/capture/sessions/${sessionId}/chunks/${objectId}/upload-authorization`,
      jar,
      jsonBody: { protocol_version: protocol.PROTOCOL_VERSION },
      idempotencyKey: "acceptance-a-authorize-v1-0001",
    };
    const authorization = await jsonCall(signal, authorizationRequest);
    expectStatus(authorization, 201, "upload_authorization");
    const authorizationReplay = await jsonCall(signal, { ...authorizationRequest, label: "upload_authorization_replay" });
    expectStatus(authorizationReplay, 201, "upload_authorization_replay");
    fixed(equalJson(authorization.body, authorizationReplay.body), "authorization_replay_changed");
    fixed(authorization.body.object_id === objectId, "authorization_object_invalid");
    fixed(authorization.body.additional_authenticated_data === reservation.additional_authenticated_data, "authorization_aad_invalid");
    const upload = parseUploadAuthorization(authorization.body.upload_url, objectId);

    const uploadHeaders = { "X-Capture-Upload-Receipt": upload.receipt };
    const malformedEnvelope = new Uint8Array([1, 2, 3]);
    const malformedUpload = await binaryCall(signal, {
      label: "malformed_envelope_upload",
      method: "PUT",
      path: upload.path,
      body: malformedEnvelope,
      headers: uploadHeaders,
    });
    expectError(malformedUpload, 422, "envelope_invalid", "malformed_envelope_upload");
    malformedEnvelope.fill(0);

    oversizedEnvelope = new Uint8Array(capabilities.max_envelope_bytes + 1);
    const oversizedUpload = await binaryCall(signal, {
      label: "oversized_envelope_upload",
      method: "PUT",
      path: upload.path,
      body: oversizedEnvelope,
      headers: uploadHeaders,
    });
    expectError(oversizedUpload, 413, "request_too_large", "oversized_envelope_upload");
    oversizedEnvelope.fill(0);
    oversizedEnvelope = null;
    emit(output, "negative_envelope_guards");

    const profile = wav.pcm16WavProfile(capabilities);
    const frameCount = wav.targetFrameCount(profile);
    const samples = new Int16Array(new ArrayBuffer(frameCount * Int16Array.BYTES_PER_ELEMENT));
    wavBytes = wav.encodePcm16MonoWav(samples, profile);
    samples.fill(0);
    nonce = crypto.getRandomValues(new Uint8Array(protocol.NONCE_BYTES));
    ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData },
      dek,
      wavBytes,
    ));
    envelope = protocol.encodeEnvelope({
      schema_version: protocol.PROTOCOL_VERSION,
      content_encryption: protocol.CONTENT_ENCRYPTION,
      nonce: protocol.base64UrlEncode(nonce),
      media_type: protocol.MEDIA_TYPE,
    }, ciphertext);
    fixed(envelope.byteLength <= capabilities.max_envelope_bytes, "envelope_limit_exceeded");
    const parsed = protocol.parseEnvelope(envelope);
    parsedCiphertext = parsed.ciphertext;
    fixed(parsed.header.content_encryption === protocol.CONTENT_ENCRYPTION, "envelope_header_invalid");
    const sha256 = createHash("sha256").update(envelope).digest("hex");
    fixed(SHA256.test(sha256), "envelope_digest_invalid");

    const wrongOriginUpload = await binaryCall(signal, {
      label: "wrong_origin_upload",
      method: "PUT",
      path: upload.path,
      origin: "https://wrong.example.invalid",
      body: envelope,
      headers: uploadHeaders,
    });
    expectError(wrongOriginUpload, 403, "preview_origin_rejected", "wrong_origin_upload");
    const uploaded = await binaryCall(signal, {
      label: "envelope_upload",
      method: "PUT",
      path: upload.path,
      body: envelope,
      headers: uploadHeaders,
    });
    expectEmptyStatus(uploaded, 201, "envelope_upload");

    const registrationRequest = {
      label: "chunk_registration",
      method: "POST",
      path: `/api/capture/sessions/${sessionId}/chunks`,
      jar,
      jsonBody: {
        object_id: objectId,
        channel: "microphone",
        sequence_number: 0,
        sha256,
        ciphertext_size_bytes: envelope.byteLength,
      },
      idempotencyKey: "acceptance-a-register-v1-0001",
    };
    const registration = await jsonCall(signal, registrationRequest);
    expectStatus(registration, 201, "chunk_registration");
    fixed(registration.body.sha256 === sha256, "registration_digest_invalid");
    fixed(registration.body.ciphertext_size_bytes === envelope.byteLength, "registration_size_invalid");
    const registrationReplay = await jsonCall(signal, { ...registrationRequest, label: "chunk_registration_replay" });
    expectStatus(registrationReplay, 201, "chunk_registration_replay");
    fixed(equalJson(registration.body, registrationReplay.body), "registration_replay_changed");

    const receipt = await jsonCall(signal, {
      label: "chunk_receipt",
      method: "GET",
      path: `/api/capture/sessions/${sessionId}/chunks/${objectId}`,
      jar,
    });
    expectStatus(receipt, 200, "chunk_receipt");
    fixed(receipt.body.state === "registered", "chunk_receipt_state_invalid");
    fixed(receipt.body.registration?.sha256 === sha256, "chunk_receipt_digest_invalid");

    const completionRequest = {
      label: "capture_complete",
      method: "POST",
      path: `/api/capture/sessions/${sessionId}/capture-complete`,
      jar,
      jsonBody: {
        protocol_version: protocol.PROTOCOL_VERSION,
        capture_lease_id: leaseId,
        capture_lease_generation: generation,
        channels: [{ channel: "microphone", final_sequence_number: 0 }],
      },
      idempotencyKey: "acceptance-a-complete-v1-0001",
    };
    const completion = await jsonCall(signal, completionRequest);
    expectStatus(completion, 200, "capture_complete");
    fixed(completion.body.status === "uploaded", "capture_complete_status_invalid");
    const completionReplay = await jsonCall(signal, { ...completionRequest, label: "capture_complete_replay" });
    expectStatus(completionReplay, 200, "capture_complete_replay");
    fixed(equalJson(completion.body, completionReplay.body), "completion_replay_changed");

    const status = await jsonCall(signal, {
      label: "transcription_status",
      method: "GET",
      path: `/api/capture/sessions/${sessionId}/transcription-status`,
      jar,
    });
    expectStatus(status, 200, "transcription_status");
    fixed(status.body.status === "completed" && status.body.transcript_available === true, "transcription_status_invalid");
    const transcript = await jsonCall(signal, {
      label: "transcript",
      method: "GET",
      path: `/api/capture/sessions/${sessionId}/transcript`,
      jar,
    });
    expectStatus(transcript, 200, "transcript");
    fixed(transcript.body.stt_provider === "synthetic-preview", "transcript_provider_invalid");
    fixed(Array.isArray(transcript.body.segments) && transcript.body.segments.length === 1, "transcript_shape_invalid");

    return {
      clear() {
        wavBytes?.fill(0);
        additionalData?.fill(0);
        nonce?.fill(0);
        ciphertext?.fill(0);
        parsedCiphertext?.fill(0);
        envelope?.fill(0);
      },
    };
  } catch (error) {
    wavBytes?.fill(0);
    additionalData?.fill(0);
    nonce?.fill(0);
    ciphertext?.fill(0);
    parsedCiphertext?.fill(0);
    envelope?.fill(0);
    oversizedEnvelope?.fill(0);
    throw error;
  }
}

function validateCapabilities(value, protocol, hostedMaxChunks) {
  exactKeys(value, [
    "capture_lease_ttl_seconds",
    "max_chunks",
    "max_envelope_bytes",
    "max_reservations_per_batch",
    "media",
    "protocol_version",
    "remaining_aggregate_plaintext_bytes",
    "reservation_window_seconds",
    "target_chunk_duration_ms",
    "upload_concurrency",
  ], "capture_capabilities");
  exactKeys(value.media, ["channels", "encoding", "media_type", "sample_rate_hz"], "capture_media");
  fixed(equalJson(value, syntheticCapabilities(protocol, hostedMaxChunks)), "capture_capabilities_policy_invalid");
}

function validateAdditionalData(bytes, sessionId, objectId) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AcceptanceFailure("reservation_aad_invalid");
  }
  exactKeys(value, ["channel", "object_id", "sequence_number", "session_id", "tenant_id"], "reservation_aad");
  fixed(value.channel === "microphone" && value.sequence_number === 0, "reservation_aad_position_invalid");
  fixed(value.session_id === sessionId && value.object_id === objectId, "reservation_aad_binding_invalid");
  fixed(typeof value.tenant_id === "string" && UUID.test(value.tenant_id), "reservation_aad_tenant_invalid");
}

function parseUploadAuthorization(value, objectId) {
  fixed(typeof value === "string", "upload_url_missing");
  let parsed;
  try {
    parsed = new URL(value, SWA_ORIGIN);
  } catch {
    throw new AcceptanceFailure("upload_url_invalid");
  }
  fixed(parsed.origin === SWA_ORIGIN, "upload_origin_invalid");
  fixed(parsed.search === "", "upload_query_present");
  fixed(parsed.hash.startsWith("#receipt="), "upload_receipt_missing");
  const receipt = parsed.hash.slice("#receipt=".length);
  fixed(UUID.test(receipt), "upload_receipt_invalid");
  fixed(new RegExp(`^/api/capture/preview/uploads/[0-9a-f]{64}/${objectId}$`, "u").test(parsed.pathname), "upload_path_invalid");
  parsed.hash = "";
  return { path: parsed.pathname, receipt };
}

function validConsent(grantedAt) {
  return {
    appointment_id: "synthetic-appointment",
    practitioner_id: "synthetic-practitioner",
    patient_id: "synthetic-patient",
    modality: "in_person",
    method: "verbal_attestation",
    all_parties_consented: true,
    participant_regions: ["US-NY"],
    granted_at: grantedAt,
    evidence_object_id: null,
  };
}

function validSession(consentId) {
  return {
    appointment_id: "synthetic-appointment",
    practitioner_id: "synthetic-practitioner",
    patient_id: "synthetic-patient",
    consent_record_id: consentId,
    modality: "in_person",
  };
}

async function jsonCall(signal, {
  label,
  method,
  path,
  jar,
  jsonBody,
  rawBody,
  contentType,
  idempotencyKey,
  origin = SWA_ORIGIN,
}) {
  fixed(jsonBody === undefined || rawBody === undefined, `${label}_body_ambiguous`);
  const headers = { Origin: origin };
  if (jar !== undefined) headers.Cookie = jar.header();
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  let body;
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(jsonBody);
  } else if (rawBody !== undefined) {
    headers["Content-Type"] = contentType ?? "application/octet-stream";
    body = rawBody;
  }
  const response = await safeFetch(label, sameOriginUrl(path), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: "error",
    cache: "no-store",
  }, { globalSignal: signal });
  assertApiHeaders(response, label, true);
  return { response, body: await readBoundedJson(response, label) };
}

async function binaryCall(signal, { label, method, path, origin = SWA_ORIGIN, body, headers = {} }) {
  const response = await safeFetch(label, sameOriginUrl(path), {
    method,
    headers: { Origin: origin, "Content-Type": "application/octet-stream", ...headers },
    body,
    redirect: "error",
    cache: "no-store",
  }, { globalSignal: signal });
  assertApiHeaders(response, label, response.status !== 201);
  if (response.status === 201) {
    const bytes = await readResponseBounded(response, 0, label);
    fixed(bytes.byteLength === 0, `${label}_response_not_empty`);
    return { response, body: null };
  }
  return { response, body: await readBoundedJson(response, label) };
}

export function sameOriginUrl(path) {
  fixed(typeof path === "string" && path.startsWith("/"), "request_path_invalid");
  let url;
  try {
    url = new URL(path, SWA_ORIGIN);
  } catch {
    throw new AcceptanceFailure("request_path_invalid");
  }
  fixed(url.origin === SWA_ORIGIN && url.hash === "" && url.search === "", "request_origin_invalid");
  return url;
}

export async function safeFetch(label, url, init, options = {}) {
  const globalSignal = options.globalSignal ?? new AbortController().signal;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  fixed(!globalSignal.aborted, "global_deadline_exceeded");
  fixed(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "request_timeout_invalid");
  const signal = AbortSignal.any([globalSignal, AbortSignal.timeout(timeoutMs)]);
  try {
    return await fetchImplementation(url, { ...init, signal });
  } catch {
    if (globalSignal.aborted) throw new AcceptanceFailure("global_deadline_exceeded");
    throw new AcceptanceFailure(`${label}_network_failed`);
  }
}

function assertApiHeaders(response, label, requireJson) {
  requireNoStore(response, label);
  fixed(response.headers.get("referrer-policy") === "no-referrer", `${label}_referrer_policy_invalid`);
  fixed(response.headers.get("x-content-type-options") === "nosniff", `${label}_content_policy_invalid`);
  if (requireJson) requireJsonContentType(response, label);
}

function requireNoStore(response, label) {
  const cacheControl = response.headers.get("cache-control") ?? "";
  fixed(/(?:^|,)\s*no-store(?:\s|,|$)/iu.test(cacheControl), `${label}_cache_policy_invalid`);
}

function requireJsonContentType(response, label) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  fixed(contentType === "application/json", `${label}_content_type_invalid`);
}

async function readBoundedJson(response, label) {
  const bytes = await readResponseBounded(response, MAX_JSON_RESPONSE_BYTES, label);
  fixed(bytes.byteLength > 0, `${label}_json_size_invalid`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AcceptanceFailure(`${label}_json_invalid`);
  } finally {
    bytes.fill(0);
  }
}

export async function readResponseBounded(response, maximumBytes, label = "response") {
  fixed(Number.isSafeInteger(maximumBytes) && maximumBytes >= 0, `${label}_response_limit_invalid`);
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      await response.body?.cancel();
      throw new AcceptanceFailure(`${label}_response_too_large`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        result.value.fill(0);
        await reader.cancel();
        throw new AcceptanceFailure(`${label}_response_too_large`);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  return bytes;
}

async function discardBounded(response, maximumBytes, label) {
  const bytes = await readResponseBounded(response, maximumBytes, label);
  bytes.fill(0);
}

function expectStatus(result, status, label) {
  fixed(result.response.status === status, `${label}_status_invalid`);
  fixed(isRecord(result.body), `${label}_body_invalid`);
}

function expectEmptyStatus(result, status, label) {
  fixed(result.response.status === status, `${label}_status_invalid`);
  fixed(result.body === null, `${label}_body_invalid`);
}

function expectError(result, status, code, label) {
  fixed(result.response.status === status, `${label}_status_invalid`);
  exactKeys(result.body, ["detail"], label);
  exactKeys(result.body.detail, ["code", "message"], label);
  fixed(result.body.detail.code === code, `${label}_error_code_invalid`);
  fixed(result.body.detail.message === "synthetic preview request rejected", `${label}_error_message_invalid`);
}

function requiredUuid(value, key, label) {
  fixed(isRecord(value) && typeof value[key] === "string" && UUID.test(value[key]), `${label}_${key}_invalid`);
  return value[key];
}

function requiredInteger(value, key, minimum, label) {
  fixed(isRecord(value) && Number.isSafeInteger(value[key]) && value[key] >= minimum, `${label}_${key}_invalid`);
  return value[key];
}

function canonicalBase64UrlBytes(value) {
  fixed(typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value), "base64url_invalid");
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  fixed(Buffer.from(bytes).toString("base64url") === value, "base64url_noncanonical");
  return bytes;
}

function exactKeys(value, expected, label) {
  fixed(isRecord(value), `${label}_shape_invalid`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  fixed(actual.length === sorted.length && actual.every((key, index) => key === sorted[index]), `${label}_shape_invalid`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function formatGateEvent(gate) {
  fixed(OUTPUT_GATES.has(gate), "output_gate_invalid");
  return `${JSON.stringify({ gate, status: "passed" })}\n`;
}

function emit(output, gate) {
  output.write(formatGateEvent(gate));
}

function fixed(condition, code) {
  if (!condition) throw new AcceptanceFailure(code);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await runCli();
}
