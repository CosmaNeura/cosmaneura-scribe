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
`apps/capture-preview-api/dist-package`. `npm run smoke:capture-preview-api -- <HTTPS origin>` runs
the non-secret live bootstrap and cookie-bound persistence probe.
