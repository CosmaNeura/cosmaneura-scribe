const rawOrigin = process.argv[2] ?? process.env.CAPTURE_PREVIEW_URL;
if (rawOrigin === undefined) {
  throw new Error("usage: npm run smoke:capture-preview-api -- https://preview.example");
}
const origin = new URL(rawOrigin);
if (
  origin.protocol !== "https:" ||
  origin.username !== "" ||
  origin.password !== "" ||
  origin.pathname !== "/" ||
  origin.search !== "" ||
  origin.hash !== ""
) {
  throw new Error("preview URL must be an HTTPS origin");
}

const health = await fetch(new URL("/api/capture/preview/health", origin), {
  headers: { Origin: origin.origin },
  redirect: "error",
  cache: "no-store",
});
if (!health.ok) throw new Error(`preview health gate failed (${String(health.status)})`);
const healthBody = await health.json();
if (healthBody.status !== "ok" || healthBody.mode !== "synthetic") {
  throw new Error("preview health policy mismatch");
}

const unauthenticated = await fetch(new URL("/api/capture/audio-encryption-key", origin), {
  headers: { Origin: origin.origin },
  redirect: "error",
  cache: "no-store",
});
if (unauthenticated.status !== 401) throw new Error("preview control route is not cookie gated");

const bootstrap = await fetch(new URL("/api/capture/preview/bootstrap", origin), {
  method: "POST",
  headers: { Origin: origin.origin },
  redirect: "error",
  cache: "no-store",
});
if (!bootstrap.ok) throw new Error(`preview bootstrap failed (${String(bootstrap.status)})`);
const bootstrapBody = await bootstrap.json();
if (
  bootstrapBody.mode !== "synthetic" ||
  bootstrapBody.microphone_enabled !== false ||
  bootstrapBody.max_chunks !== 6
) {
  throw new Error("preview bootstrap policy mismatch");
}
const setCookie = bootstrap.headers.get("set-cookie");
const cookie = setCookie?.split(";", 1)[0];
if (cookie === undefined || !cookie.startsWith("__Host-capture_preview=")) {
  throw new Error("preview bootstrap cookie missing");
}

const key = await fetch(new URL("/api/capture/audio-encryption-key", origin), {
  headers: { Cookie: cookie, Origin: origin.origin },
  redirect: "error",
  cache: "no-store",
});
if (!key.ok) throw new Error(`preview persistence probe failed (${String(key.status)})`);
const keyBody = await key.json();
if (
  keyBody.algorithm !== "RSA-OAEP-256" ||
  keyBody.public_jwk?.kty !== "RSA" ||
  "d" in (keyBody.public_jwk ?? {})
) {
  throw new Error("preview public key policy mismatch");
}

process.stdout.write(
  `${JSON.stringify({ gate: "capture_preview_live_smoke", status: "passed", origin: origin.origin })}\n`,
);
