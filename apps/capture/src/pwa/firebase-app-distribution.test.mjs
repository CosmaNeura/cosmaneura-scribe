import { describe, expect, it, vi } from "vitest";

import { publishFirebaseBinary } from "./firebase-app-distribution.mjs";

const APP_ID = "1:123456789:android:abcdef1234567890";
const APP_RESOURCE = `projects/123456789/apps/${APP_ID}`;
const OPERATION_NAME = `${APP_RESOURCE}/releases/release-one/operations/operation-one`;
const RELEASE_NAME = `${APP_RESOURCE}/releases/release-one`;

describe("Firebase preview distribution", () => {
  it("uploads, polls, annotates, and distributes one synthetic APK", async () => {
    const responses = [
      jsonResponse({ name: OPERATION_NAME, done: false }),
      jsonResponse({
        name: OPERATION_NAME,
        done: true,
        response: { result: "RELEASE_CREATED", release: { name: RELEASE_NAME } },
      }),
      jsonResponse({ name: RELEASE_NAME }),
      jsonResponse({}),
    ];
    const fetchImplementation = vi.fn(async () => responses.shift());
    const sleep = vi.fn(async () => undefined);

    await publishFirebaseBinary({
      accessToken: "synthetic-access-token-value",
      androidAppId: APP_ID,
      apkBytes: new Uint8Array([1, 2, 3]),
      pullRequestNumber: "42",
      sleep,
      testerGroup: "capture-preview",
      fetchImplementation,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(String(fetchImplementation.mock.calls[0][0])).toBe(
      `https://firebaseappdistribution.googleapis.com/upload/v1/projects/123456789/apps/${encodeURIComponent(APP_ID)}/releases:upload?uploadType=media`,
    );
    expect(fetchImplementation.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer synthetic-access-token-value",
    );
    expect(fetchImplementation.mock.calls[2][1].body).toBe(
      JSON.stringify({
        name: RELEASE_NAME,
        releaseNotes: { text: "Synthetic capture preview PR 42" },
      }),
    );
    expect(fetchImplementation.mock.calls[3][1].body).toBe(
      JSON.stringify({ groupAliases: ["capture-preview"] }),
    );
  });

  it("rejects a non-Android Firebase application ID before network access", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      publishFirebaseBinary({
        accessToken: "synthetic-access-token-value",
        androidAppId: "1:123456789:web:abcdef1234567890",
        apkBytes: new Uint8Array([1]),
        pullRequestNumber: "42",
        testerGroup: "capture-preview",
        fetchImplementation,
      }),
    ).rejects.toThrow("firebase_app_id_invalid");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("fails closed when the upload operation reports an error", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ name: OPERATION_NAME, done: true, error: { code: 7 } }),
    );

    await expect(
      publishFirebaseBinary({
        accessToken: "synthetic-access-token-value",
        androidAppId: APP_ID,
        apkBytes: new Uint8Array([1]),
        pullRequestNumber: "42",
        testerGroup: "capture-preview",
        fetchImplementation,
      }),
    ).rejects.toThrow("firebase_upload_incomplete");
  });
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
