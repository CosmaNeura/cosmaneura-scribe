import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API_ORIGIN = "https://firebaseappdistribution.googleapis.com";
const MAX_APK_BYTES = 500 * 1_024 * 1_024;
const MAX_JSON_BYTES = 65_536;
const MAX_OPERATION_POLLS = 60;
const OPERATION_POLL_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 180_000;

export async function publishFirebaseBinary({
  accessToken,
  androidAppId,
  apkBytes,
  pullRequestNumber,
  sleep = defaultSleep,
  testerGroup,
  fetchImplementation = fetch,
}) {
  validateAccessToken(accessToken);
  const projectNumber = parseProjectNumber(androidAppId);
  validateTesterGroup(testerGroup);
  validatePullRequestNumber(pullRequestNumber);
  if (!(apkBytes instanceof Uint8Array) || apkBytes.byteLength < 1 || apkBytes.byteLength > MAX_APK_BYTES) {
    throw new PreviewDistributionError("firebase_apk_invalid");
  }

  const appResource = `projects/${projectNumber}/apps/${androidAppId}`;
  const uploadUrl = new URL(
    `/upload/v1/projects/${projectNumber}/apps/${encodeURIComponent(androidAppId)}/releases:upload`,
    API_ORIGIN,
  );
  uploadUrl.searchParams.set("uploadType", "media");
  let operation = await requestJson(
    uploadUrl,
    {
      method: "POST",
      headers: authorizedHeaders(accessToken, "application/vnd.android.package-archive"),
      body: apkBytes,
    },
    fetchImplementation,
  );
  const operationName = validateOperationName(operation?.name, appResource);

  for (let attempt = 0; operation?.done !== true && attempt < MAX_OPERATION_POLLS; attempt += 1) {
    await sleep(OPERATION_POLL_DELAY_MS);
    operation = await requestJson(
      new URL(`/v1/${operationName}`, API_ORIGIN),
      { method: "GET", headers: authorizedHeaders(accessToken) },
      fetchImplementation,
    );
  }
  if (operation?.done !== true || operation.error !== undefined) {
    throw new PreviewDistributionError("firebase_upload_incomplete");
  }

  const releaseName = validateReleaseName(operation.response?.release?.name, appResource);
  const uploadResult = operation.response?.result;
  if (!new Set(["RELEASE_CREATED", "RELEASE_UPDATED", "RELEASE_UNMODIFIED"]).has(uploadResult)) {
    throw new PreviewDistributionError("firebase_upload_response_invalid");
  }

  const releaseUrl = new URL(`/v1/${releaseName}`, API_ORIGIN);
  releaseUrl.searchParams.set("updateMask", "releaseNotes.text");
  const releaseNotes = `Synthetic capture preview PR ${pullRequestNumber}`;
  const updatedRelease = await requestJson(
    releaseUrl,
    {
      method: "PATCH",
      headers: authorizedHeaders(accessToken, "application/json"),
      body: JSON.stringify({ name: releaseName, releaseNotes: { text: releaseNotes } }),
    },
    fetchImplementation,
  );
  if (updatedRelease?.name !== releaseName) {
    throw new PreviewDistributionError("firebase_release_update_invalid");
  }

  await requestJson(
    new URL(`/v1/${releaseName}:distribute`, API_ORIGIN),
    {
      method: "POST",
      headers: authorizedHeaders(accessToken, "application/json"),
      body: JSON.stringify({ groupAliases: [testerGroup] }),
    },
    fetchImplementation,
  );
}

async function publishFromEnvironment(apkPath) {
  if (typeof apkPath !== "string" || !apkPath.endsWith(".apk")) {
    throw new PreviewDistributionError("firebase_apk_path_invalid");
  }
  const metadata = await stat(apkPath);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_APK_BYTES) {
    throw new PreviewDistributionError("firebase_apk_invalid");
  }
  await publishFirebaseBinary({
    accessToken: process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
    androidAppId: process.env.CAPTURE_PREVIEW_FIREBASE_ANDROID_APP_ID,
    apkBytes: await readFile(apkPath),
    pullRequestNumber: process.env.CAPTURE_PREVIEW_PULL_REQUEST_NUMBER,
    testerGroup: process.env.CAPTURE_PREVIEW_FIREBASE_TESTER_GROUP,
  });
}

function authorizedHeaders(accessToken, contentType) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    ...(contentType === undefined ? {} : { "Content-Type": contentType }),
  };
}

async function requestJson(url, init, fetchImplementation) {
  let response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PreviewDistributionError("firebase_request_failed");
  }
  if (!response.ok) {
    throw new PreviewDistributionError("firebase_request_rejected");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new PreviewDistributionError("firebase_response_type_invalid");
  }
  const bytes = await readBoundedBody(response);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PreviewDistributionError("firebase_response_json_invalid");
  }
}

async function readBoundedBody(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_JSON_BYTES) {
      throw new PreviewDistributionError("firebase_response_too_large");
    }
  }
  if (response.body === null) {
    throw new PreviewDistributionError("firebase_response_body_missing");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new PreviewDistributionError("firebase_response_too_large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validateAccessToken(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 8_192 || /\s/u.test(value)) {
    throw new PreviewDistributionError("firebase_access_token_invalid");
  }
}

function parseProjectNumber(value) {
  const match = /^1:(\d{6,20}):android:[a-f\d]{8,64}$/u.exec(value ?? "");
  if (match === null) throw new PreviewDistributionError("firebase_app_id_invalid");
  return match[1];
}

function validateTesterGroup(value) {
  if (typeof value !== "string" || !/^[a-z\d][a-z\d_-]{0,62}$/u.test(value)) {
    throw new PreviewDistributionError("firebase_tester_group_invalid");
  }
}

function validatePullRequestNumber(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/u.test(value)) {
    throw new PreviewDistributionError("firebase_pull_request_invalid");
  }
}

function validateOperationName(value, appResource) {
  const pattern = new RegExp(`^${escapeRegExp(appResource)}/releases/[^/]+/operations/[^/]+$`, "u");
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new PreviewDistributionError("firebase_operation_invalid");
  }
  return value;
}

function validateReleaseName(value, appResource) {
  const pattern = new RegExp(`^${escapeRegExp(appResource)}/releases/[^/]+$`, "u");
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new PreviewDistributionError("firebase_release_invalid");
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class PreviewDistributionError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreviewDistributionError";
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishFromEnvironment(process.argv[2])
    .then(() => {
      console.log(JSON.stringify({ action: "capture_preview.firebase_distributed" }));
    })
    .catch(() => {
      console.error(JSON.stringify({ action: "capture_preview.firebase_distribution_failed" }));
      process.exitCode = 1;
    });
}
