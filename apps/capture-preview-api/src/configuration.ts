import type { CosmosPreviewRepositoryOptions } from "./cosmos-repository";

export interface PreviewConfiguration extends CosmosPreviewRepositoryOptions {
  readonly allowedHosts: readonly string[];
}

export function readConfiguration(environment: NodeJS.ProcessEnv): PreviewConfiguration {
  const endpoint = requireEnvironment(environment, "CAPTURE_PREVIEW_COSMOS_ENDPOINT");
  const parsedEndpoint = new URL(endpoint);
  if (
    parsedEndpoint.protocol !== "https:" ||
    parsedEndpoint.username !== "" ||
    parsedEndpoint.password !== "" ||
    parsedEndpoint.pathname !== "/" ||
    parsedEndpoint.search !== "" ||
    parsedEndpoint.hash !== "" ||
    parsedEndpoint.port !== "" ||
    !parsedEndpoint.hostname.endsWith(".documents.azure.com")
  ) {
    throw new Error("CAPTURE_PREVIEW_COSMOS_ENDPOINT is invalid");
  }
  const databaseId = requireIdentifier(environment, "CAPTURE_PREVIEW_COSMOS_DATABASE");
  const containerId = requireIdentifier(environment, "CAPTURE_PREVIEW_COSMOS_CONTAINER");
  const managedIdentityClientId = requireEnvironment(
    environment,
    "CAPTURE_PREVIEW_MANAGED_IDENTITY_CLIENT_ID",
  );
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    managedIdentityClientId,
  )) {
    throw new Error("CAPTURE_PREVIEW_MANAGED_IDENTITY_CLIENT_ID is invalid");
  }
  const allowedHosts = requireEnvironment(environment, "CAPTURE_PREVIEW_ALLOWED_HOSTS")
    .split(",")
    .map((host) => host.trim().toLowerCase());
  if (
    allowedHosts.length === 0 ||
    new Set(allowedHosts).size !== allowedHosts.length ||
    allowedHosts.some(
      (host) =>
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(host) ||
        !host.endsWith(".azurestaticapps.net"),
    )
  ) {
    throw new Error("CAPTURE_PREVIEW_ALLOWED_HOSTS is invalid");
  }
  return { endpoint, databaseId, containerId, managedIdentityClientId, allowedHosts };
}

function requireEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function requireIdentifier(environment: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnvironment(environment, name);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}
