import { app, type HttpRequest, type HttpResponseInit } from "@azure/functions";
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_TTL_SECONDS,
  PreviewCaptureDomain,
  createPreviewRequestHandler,
} from "@cosmaneura-scribe/capture-preview-domain";

import { CosmosPreviewRepository } from "./cosmos-repository";
import { readConfiguration } from "./configuration";

declare const __CAPTURE_PREVIEW_DEPLOY_SHA__: string;

const configuration = readConfiguration(process.env);
const repository = new CosmosPreviewRepository(configuration);
const handle = createPreviewRequestHandler(new PreviewCaptureDomain(repository), {
  allowedHosts: configuration.allowedHosts,
  allowedHostSuffixes: [],
  deploymentSourceSha: __CAPTURE_PREVIEW_DEPLOY_SHA__,
});

app.http("capturePreview", {
  authLevel: "anonymous",
  methods: ["GET", "POST", "PUT"],
  route: "capture/{*path}",
  handler: async (request): Promise<HttpResponseInit> => {
    const webRequest = await toWebRequest(request);
    return fromWebResponse(await handle(webRequest));
  },
});

async function toWebRequest(request: HttpRequest): Promise<Request> {
  const method = request.method.toUpperCase();
  // The Function host rejects bodies above FUNCTIONS_REQUEST_BODY_SIZE_LIMIT
  // before invocation. The domain reader then applies its narrower route limit.
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  return new Request(request.url, {
    method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function fromWebResponse(response: Response): Promise<HttpResponseInit> {
  const headers = Object.fromEntries(response.headers.entries());
  const setCookie = response.headers.get("set-cookie");
  delete headers["set-cookie"];
  return {
    status: response.status,
    headers,
    body: Buffer.from(await response.arrayBuffer()),
    ...(setCookie === null
      ? {}
      : {
          cookies: [
            {
              name: PREVIEW_COOKIE_NAME,
              value: parseCookieValue(setCookie),
              path: "/",
              maxAge: PREVIEW_TTL_SECONDS,
              secure: true,
              httpOnly: true,
              sameSite: "Strict" as const,
            },
          ],
        }),
  };
}

function parseCookieValue(header: string): string {
  const prefix = `${PREVIEW_COOKIE_NAME}=`;
  const first = header.split(";", 1)[0] ?? "";
  if (!first.startsWith(prefix)) throw new Error("preview cookie response is invalid");
  return first.slice(prefix.length);
}
