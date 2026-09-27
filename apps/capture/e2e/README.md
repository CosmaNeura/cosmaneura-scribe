# Capture browser verification

This isolated Playwright package drives the false-default capture companion against the loopback
mock BFF. Chromium receives a pinned, deidentified PCM16 mono 16 kHz WAV through its fake microphone
device; no physical microphone, patient audio, production identity, or cloud service is used.

The single flow holds the ciphertext upload, closes the page after one encrypted queue record is
durable, relaunches the UI on the same browser profile, and then proves upload, registration, capture
completion, and the read-only transcript-ready state. The captured PUT body is kept in memory only
and checked against the repository's protocol golden-vector framing plus the registration digest.
Playwright traces, screenshots, and video are disabled so upload credentials and payloads are not
written to test artifacts.

The separate full-stack flow drives the same browser UI through the real FastAPI capture routes and
a fresh disposable PostgreSQL database. The host refuses a database that already holds any object in
the `public` schema, migrates it as the connecting owner, and serves the API as a per-database
`NOSUPERUSER NOBYPASSRLS` role holding the production runtime grants, so forced row-level security
applies to every request. A dedicated Vite config (`vite.full-stack.config.mjs`) stands in for the
BFF: it rewrites `/api/capture` to `/v1` and adds the synthetic `X-Tenant-ID`. After completion
the spec checks persisted session, chunk, transcript, and metadata-only audit evidence.

Some of the browser's traffic does not reach the API:

- `GET /api/capture/sessions/{id}/transcription-status` is fulfilled in the page. `services/api` has
  no transcription-status endpoint. The stub reports `processing`, then `completed`.
- Before the first `completed` answer the spec writes a synthetic transcript through the real
  `POST /v1/sessions/{id}/transcript` route, in place of a transcription provider. The browser's
  `GET /transcript` is then served by the API from PostgreSQL.
- Ciphertext `PUT`s to the synthetic upload grant URL (`/real-upload/…`) are fulfilled in the page;
  no blob storage is involved. Audio encryption keys come from a synthetic key provider.

This flow does not claim Azure Speech, managed-identity, private network, physical microphone, or
production readiness.

Run with the repository's pinned Node and npm versions:

```sh
npm ci
npm ci --prefix apps/capture/e2e
npm ls --all --prefix apps/capture/e2e
npm exec --prefix apps/capture/e2e -- playwright install chromium
npm test --prefix apps/capture/e2e

# Requires uv sync --all-groups and a fresh database whose name ends in _test, reached as a
# role that may create roles.
COSMANEURA_SCRIBE_E2E_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:55438/cosmaneura_scribe_e2e_test \
  npm run test:full-stack --prefix apps/capture/e2e
```
