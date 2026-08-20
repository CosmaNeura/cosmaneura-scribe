# Synthetic capture preview API

This Azure Function is a non-production, synthetic-only implementation of the capture BFF contract.
It uses a managed identity for Cosmos DB, stores each browser preview in a host-and-cookie-derived
partition, expires all records through Cosmos TTL, and caps each scope at six encrypted silent WAV
chunks. It has no clinical tenant, patient, Scribe, Speech, storage, or production BFF connection.

Control state expires after 24 hours. Encrypted envelopes expire after one hour and are deleted
immediately after their ETag-protected registration commit; a crash can therefore leave only a
bounded encrypted residual, never a registration without a durable digest/length receipt. Upload
capabilities travel in a URL fragment and are moved into a request header by the browser adapter,
so the Function request path/query contains no capability. Function request/URL telemetry is
disabled in `host.json`; the deployment must not enable raw HTTP access logging upstream.

`npm run build:capture-preview-api` produces the complete deployment directory at
`apps/capture-preview-api/dist-package`. The build requires `DEPLOY_SHA` to be the exact lowercase
40-character source commit and compiles that value into the non-secret
`GET /api/capture/preview/deployment` response. Its exact JSON contract is
`{"schema_version":1,"source_sha":"<commit>","mode":"synthetic","microphone_enabled":false}`
with `Cache-Control: no-store`; it contains no configuration value or credential.

The committed acceptance runner requires two matching exact-SHA inputs, exact
protected-environment origins that match its fixed SWA and Function targets, and an explicit
synthetic-only authorization gate; its dry-run mode performs no network request. The superseded
arbitrary-origin bootstrap smoke command was removed so operators cannot bypass these bindings.

```sh
npm run acceptance:dry --workspace @cosmaneura-scribe/capture-preview-api
CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED=synthetic-only \
  CAPTURE_PREVIEW_DEPLOYED_SHA=<exact-main-sha> \
  CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN=https://green-rock-0cd7d7e0f.7.azurestaticapps.net \
  CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN=https://cmn-cap-prev-api-p8x6m2.azurewebsites.net \
  npm run acceptance:live --workspace @cosmaneura-scribe/capture-preview-api \
  -- --expected-sha <exact-main-sha>
```

Live mode is reserved for an explicitly authorized synthetic run. It uses fixed preview origins;
callers cannot redirect it to another site.
