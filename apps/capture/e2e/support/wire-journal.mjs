export class WireJournal {
  #allowSafeReadAbort = false;
  #bffMutationWithoutIdempotencyKey = 0;
  #captureResponses = [];
  #completions = [];
  #failedResponses = [];
  #lastResponse = "none";
  #registrations = [];
  #requestFailures = [];
  #successfulRequests = new WeakSet();
  #uploads = [];

  constructor(context) {
    context.on("request", (request) => this.#record(request));
    context.on("requestfailed", (request) => {
      const endpoint = endpointCode(request);
      if (
        !endpoint.endsWith(":other") &&
        !(this.#allowSafeReadAbort && request.method() === "GET")
      ) {
        this.#requestFailures.push({ endpoint, request });
      }
    });
    context.on("response", (response) => {
      const endpoint = endpointCode(response.request());
      if (endpoint.endsWith(":other")) return;
      this.#lastResponse = `${endpoint}:${String(response.status())}`;
      this.#captureResponses.push(this.#lastResponse);
      if (response.status() < 400) this.#successfulRequests.add(response.request());
      if (response.status() >= 400) {
        this.#failedResponses.push({
          endpoint: endpointCode(response.request()),
          status: response.status(),
        });
      }
    });
  }

  get uploadCount() {
    return this.#uploads.length;
  }

  get registrationCount() {
    return this.#registrations.length;
  }

  get completionCount() {
    return this.#completions.length;
  }

  firstUpload() {
    const registration = this.firstRegistration();
    const upload = this.#uploads.find(({ objectId }) => objectId === registration.objectId);
    if (upload === undefined) throw new Error("wire_upload_missing");
    return upload.envelope;
  }

  firstRegistration() {
    const registration = this.#registrations.find(({ sequenceNumber }) => sequenceNumber === 0);
    if (registration === undefined) throw new Error("wire_registration_missing");
    return registration;
  }

  firstCompletion() {
    const completion = this.#completions[0];
    if (completion === undefined) throw new Error("wire_completion_missing");
    return completion;
  }

  beginExpectedPageTermination() {
    this.#allowSafeReadAbort = true;
  }

  endExpectedPageTermination() {
    this.#allowSafeReadAbort = false;
  }

  assertMutationHeaders() {
    if (this.#bffMutationWithoutIdempotencyKey !== 0) {
      throw new Error("bff_mutation_idempotency_key_missing");
    }
  }

  assertSuccessfulResponses() {
    const requestFailure = this.#requestFailures.find(
      ({ request }) => !this.#successfulRequests.has(request),
    );
    if (requestFailure !== undefined) {
      throw new Error(
        `wire_request_failed:${requestFailure.endpoint}:after:${this.captureResponseTrail()}`,
      );
    }
    const failedResponse = this.#failedResponses[0];
    if (failedResponse !== undefined) {
      throw new Error(
        `wire_response_failed:${failedResponse.endpoint}:${String(failedResponse.status)}`,
      );
    }
  }

  lastResponseCode() {
    return this.#lastResponse;
  }

  captureResponseTrail() {
    return this.#captureResponses.join(",");
  }

  #record(request) {
    const method = request.method();
    const pathname = new URL(request.url()).pathname;
    if (method === "POST" && pathname.startsWith("/api/capture/")) {
      const key = request.headers()["idempotency-key"];
      if (typeof key !== "string" || key.length < 8 || key.length > 255) {
        this.#bffMutationWithoutIdempotencyKey += 1;
      }
    }

    if (method === "PUT" && pathname.startsWith("/mock-upload/")) {
      const body = request.postDataBuffer();
      if (body === null) throw new Error("wire_upload_body_missing");
      this.#uploads.push({
        envelope: Buffer.from(body),
        objectId: decodeURIComponent(pathname.slice("/mock-upload/".length)),
      });
      return;
    }

    if (method === "POST" && /\/chunks$/u.test(pathname)) {
      const body = requestJson(request, "wire_registration_body_invalid");
      this.#registrations.push({
        channel: body.channel,
        objectId: body.object_id,
        sequenceNumber: body.sequence_number,
        sha256: body.sha256,
        ciphertextSizeBytes: body.ciphertext_size_bytes,
      });
      return;
    }

    if (method === "POST" && pathname.endsWith("/capture-complete")) {
      const body = requestJson(request, "wire_completion_body_invalid");
      this.#completions.push({
        protocolVersion: body.protocol_version,
        channels: Array.isArray(body.channels)
          ? body.channels.map((channel) => ({
              channel: channel.channel,
              final_sequence_number: channel.final_sequence_number,
            }))
          : [],
      });
    }
  }
}

export async function installSingleUploadGate(context) {
  let releaseUpload;
  let reportHeld;
  let held = false;
  const released = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const heldRequest = new Promise((resolve) => {
    reportHeld = resolve;
  });

  await context.route("**/mock-upload/**", async (route) => {
    if (!held && route.request().method() === "PUT") {
      held = true;
      reportHeld();
      await released;
    }
    await route.continue();
  });

  return {
    waitUntilHeld: () => heldRequest,
    release: () => releaseUpload(),
  };
}

function requestJson(request, code) {
  const value = request.postData();
  if (value === null) throw new Error(code);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(code);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(code);
  }
  return parsed;
}

function endpointCode(request) {
  const method = request.method().toLowerCase();
  const pathname = new URL(request.url()).pathname;
  if (pathname === "/api/capture/audio-encryption-key") return `${method}:audio-key`;
  if (pathname === "/api/capture/consents") return `${method}:consent`;
  if (pathname === "/api/capture/sessions") return `${method}:session`;
  if (pathname.startsWith("/mock-upload/")) return `${method}:upload`;
  if (pathname.endsWith("/audio-key")) return `${method}:session-audio-key`;
  if (pathname.endsWith("/capture-capabilities")) return `${method}:capabilities`;
  if (pathname.endsWith("/capture-lease")) return `${method}:capture-lease`;
  if (pathname.endsWith("/chunk-reservations")) return `${method}:reservations`;
  if (pathname.endsWith("/upload-authorization")) return `${method}:upload-authorization`;
  if (pathname.endsWith("/chunks")) return `${method}:registration`;
  if (pathname.endsWith("/capture-complete")) return `${method}:complete`;
  if (pathname.endsWith("/transcription-status")) return `${method}:transcription-status`;
  if (pathname.endsWith("/transcript")) return `${method}:transcript`;
  return `${method}:other`;
}
