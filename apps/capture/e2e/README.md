# Capture browser verification

This isolated Playwright package drives the false-default capture companion against the loopback
mock BFF. Chromium receives a pinned, deidentified PCM16 mono 16 kHz WAV through its fake microphone
device; no physical microphone, patient audio, production identity, or cloud service is used.

The capture flow holds the ciphertext upload, closes the page after one encrypted queue record is
durable, relaunches the UI on the same browser profile, and then proves upload, registration, capture
completion, and the read-only transcript-ready state. The captured PUT body is kept in memory only
and checked against the repository's protocol golden-vector framing plus the registration digest.
Playwright traces, screenshots, and video are disabled so upload credentials and payloads are not
written to test artifacts.

Run with the repository's pinned Node and npm versions:

```sh
npm ci
npm ci --prefix apps/capture/e2e
npm ls --all --prefix apps/capture/e2e
npm exec --prefix apps/capture/e2e -- playwright install chromium
npm test --prefix apps/capture/e2e
```

## Repeatable operational baseline

The lab adds an axe WCAG A/AA scan of the synthetic capture setup and named
timing phases for open, prepare, start, durable chunk, recovery, stop/upload
and completion. Four note-editor checks use the actual workspace and encrypted
journal at desktop and 390-pixel mobile widths. They edit a synthetic draft,
save it, close the page, and reopen the exact visit twice. Lost-response cases
commit the mock save and drop its response, then verify explicit recovery after
relaunch uses the retained request and never submits a second save. Save requests
carry the original note/source hashes; unchanged fields and the requirement for
clinical review remain intact.

The note fixture starts from an invented ready transcript and existing draft;
it does not generate either or assess clinical quality. It rejects external
network requests and microphone calls. Its WebCrypto fixture models the native
secure-store revision contract, not physical Keychain custody. There is no
native permission, physical audio, staging patient creation or real Core note
acceptance in this suite.

After committing the intended inputs, run from a clean checkout with Node 24
and npm 11.5.2 on PATH:

```sh
npm run lab:check
npm run lab:browser -- /absolute/new/evidence-directory 3
```

Install the root and isolated E2E dependencies using the commands above first.
The output directory must not exist and should be outside the source checkout.
Each of 1–10 explicit trials starts fresh mock servers. The first failure stops
the run; skipped tests, retries, missing evidence and source changes fail the
baseline. `RESULT.json` records the exact commit, dependency lock digest and
trial outcomes; `trial-N.json` contains allowlisted metadata and named phase
durations. Nested step durations overlap and must not be added together.

The reporter deliberately excludes titles, console/error text, request bodies,
credentials, source snippets and attachments. Full traces, screenshots and
video remain off. The accessibility assertion reports rule IDs and counts,
not axe's raw HTML excerpts. A negative-path test checks that failure remains
visible while opaque content is omitted. Use the ordinary local test command
above when diagnosing a failure on the synthetic fixture.

The long `durable_chunk` phase includes the configured chunk acquisition time.
It is not real microphone startup or a performance regression by itself.
The `note_open`, `note_save`, `note_reopen` and `note_recover` phases end at the
asserted visible UI state. Their local mock timings exclude real Core/model
latency and must not be presented as measured native speed improvements.
Compare the same phases, source/fixture and machine conditions across runs;
three repetitions do not establish a reliable p95. Physical iPhone, Electron
native dialogs, actual Zoom capture, saved Core notes and long-visit recovery
remain separate qualification paths.
