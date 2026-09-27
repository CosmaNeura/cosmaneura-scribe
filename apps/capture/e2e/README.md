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
a fresh disposable PostgreSQL database. It verifies persisted session, chunk, and metadata-only
audit evidence after completion. Upload storage and the post-upload transcription provider remain
deterministic synthetic adapters: this test does not claim Azure Speech, managed-identity, private
network, physical microphone, or production readiness.

Run with the repository's pinned Node and npm versions:

```sh
npm ci
npm ci --prefix apps/capture/e2e
npm ls --all --prefix apps/capture/e2e
npm exec --prefix apps/capture/e2e -- playwright install chromium
npm test --prefix apps/capture/e2e

# Requires a fresh database whose name ends in _test.
COSMANEURA_SCRIBE_E2E_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:55438/cosmaneura_scribe_e2e_test \
  npm run test:full-stack --prefix apps/capture/e2e
```
