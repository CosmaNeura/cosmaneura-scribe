import { describe, expect, it } from "vitest";

import { readConfiguration } from "./configuration";

const VALID = Object.freeze({
  CAPTURE_PREVIEW_COSMOS_ENDPOINT: "https://preview.documents.azure.com/",
  CAPTURE_PREVIEW_COSMOS_DATABASE: "capture-preview",
  CAPTURE_PREVIEW_COSMOS_CONTAINER: "scopes",
  CAPTURE_PREVIEW_MANAGED_IDENTITY_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  CAPTURE_PREVIEW_ALLOWED_HOSTS: "capture.example.azurestaticapps.net",
});

describe("readConfiguration", () => {
  it("accepts only the explicit managed-identity and HTTPS Cosmos configuration", () => {
    expect(readConfiguration(VALID)).toEqual({
      endpoint: "https://preview.documents.azure.com/",
      databaseId: "capture-preview",
      containerId: "scopes",
      managedIdentityClientId: "11111111-1111-4111-8111-111111111111",
      allowedHosts: ["capture.example.azurestaticapps.net"],
    });
  });

  it.each([
    { ...VALID, CAPTURE_PREVIEW_COSMOS_ENDPOINT: "http://preview.documents.azure.com/" },
    { ...VALID, CAPTURE_PREVIEW_COSMOS_ENDPOINT: "https://attacker.example/" },
    { ...VALID, CAPTURE_PREVIEW_MANAGED_IDENTITY_CLIENT_ID: "not-a-client-id" },
    { ...VALID, CAPTURE_PREVIEW_ALLOWED_HOSTS: "https://capture.example" },
    { ...VALID, CAPTURE_PREVIEW_ALLOWED_HOSTS: "*.azurestaticapps.net" },
  ])("fails closed for invalid runtime configuration", (environment) => {
    expect(() => readConfiguration(environment)).toThrow();
  });
});
