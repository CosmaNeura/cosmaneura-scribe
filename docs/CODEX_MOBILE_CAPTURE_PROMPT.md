# Prompt to push to Codex — mobile capture companion (scope expansion)

Written 2026-08-17 against `main` at `7423f7f`. This is a scope expansion, not a replacement for
the acceptance-contract round in `CODEX_NEXT_PROMPT.md` — that round's precondition gate is Phase 0
below. Paste everything between the rules. `CLAUDE.md`'s hard rules still bind.

---

## Mission

Add a focused iOS + Android recording companion — record a consented patient visit, upload it
securely, and show the transcript when the backend produces it — using **Capacitor** so one
TypeScript codebase serves the P1a web/PWA client and the P1b native shells.

You are not designing this from scratch. ADR 0011 defines the encrypted chunk protocol, ADR 0016
defines the entire client capture path, and both are binding. The stack is FastAPI on internal-only
Azure Container Apps; transcription is server-side Azure AI Speech behind the leased worker. Three
consequences before anything else:

- **The app never calls Scribe and never calls Azure AI Speech.** It authenticates to the master
  platform as a user (authorization-code + PKCE) and talks only to the platform BFF, which holds the
  workload identity and derives the tenant. No Entra token, Blob hostname, Key Vault URL, or Azure
  resource ID ever reaches the client.
- **The app implements the ADR 0011 client protocol, not "upload audio to Blob."** It generates one
  32-byte session DEK, wraps it with the published RSA-3072 JWK (RSA-OAEP-256), binds it before any
  audio, and uploads only complete AES-256-GCM envelopes with server-issued AAD and unique 12-byte
  nonces, over the private upload edge.
- **Transcript display is read-only.** Editing transcripts belongs to the platform's note flow, not
  this app. The app's flow ends at: transcription status → view transcript → done.

## Standing rules

Rules 1–10 from `CODEX_NEXT_PROMPT.md` apply verbatim, especially: fix before extend; proven on the
path that runs in Azure; never a second definition of a rule; verified means something real returned
the expected answer; report blockers as specific asks. Additions for this workstream:

11. **The Python protocol code is authoritative until Phase 1 promotes it.** The TypeScript client
    must consume the generated/pinned protocol package. Re-implementing envelope framing, AAD
    encoding, JSON ordering, enums, or limits by hand in the client is rejected — ADR 0016 says so
    explicitly.
12. **No lossy audio, no format guessing.** The server assembler accepts uncompressed WAV
    (PCM16 mono 16 kHz for in-person capture) and rejects everything else. If no maintained
    Capacitor plugin yields chunked raw PCM, write a small custom Capacitor plugin (Swift/Kotlin)
    rather than adopting an unmaintained plugin or transcoding AAC into WAV.
13. **Each phase is one PR with all gates green** — the full Python suite with PostgreSQL, ruff,
    pyright, the three guard scripts, OpenAPI parity, `tofu fmt`/`validate`, and (from Phase 2) the
    new TypeScript lint/test/build gates. Do not start phase N+1 in phase N's PR.

## Phase 0 — Preconditions and the superseding ADR

1. Complete (or confirm complete, with outputs) the acceptance-contract round in
   `CODEX_NEXT_PROMPT.md`: the two-phase readiness contract, the live JWK proof, **the revocation of
   the eight temporary runner assignments and two NSG rules**, and the committed change record. The
   mobile workstream does not start while vault Crypto Officer sits on a wedged runner.
2. Read `CLAUDE.md`, ADRs 0009, 0011, 0012, 0013, 0016, `docs/TRANSCRIPTION_WORKER.md`, and the
   envelope/AAD functions in `audio_assembly.py`. Do not modify existing behavior in this phase.
3. Write **ADR 0018: Capacitor supersedes the React Native decision in ADR 0009**. It must record,
   honestly:
   - The reason: one TypeScript codebase for P1a web/PWA and P1b native shells, sharing the
     generated protocol package — collapsing two client builds into one.
   - **The custody model change.** ADR 0016 assumed native mobile crypto in native modules backed by
     Keychain/Keystore. In Capacitor, the DEK lives in WebCrypto inside a first-party-only webview
     (`capacitor://localhost`, no third-party script), with the at-rest wrapping key in
     Keychain/Keystore via a native secure-storage plugin, cloud backup disabled. State plainly that
     this is stronger than general web custody and weaker than pure-native custody, and that
     ADR 0009's "the mobile app is not a webview" sentence is superseded.
   - What survives from ADR 0009 unchanged: platform-specific acceptance tests for background/lock/
     route changes, signed builds, encrypted offline queue, local purge, and no PHI in analytics,
     crash reporting, or notifications.
4. Decide and record where the app lives — recommend `apps/capture/` in this repository, since the
   golden vectors and generated protocol package live here and the existing `apps/` stubs already
   mark the boundary. Fold the `apps/web-capture` and `apps/mobile-capture` README stubs into it.

## Phase 1 — Server prerequisites (ADR 0016 rollout step 2; this repo, Python)

The current `/upload-grant` creates a new object per idempotency key and is explicitly "not
sufficient for offline recovery." Build the contract ADR 0016 specifies, flags false:

1. **Chunk reservations**: tenant-scoped, consent-gated, idempotent binding of
   `(session, channel, sequence)` → one server-generated `object_id`, returning the exact base64url
   AAD bytes from the authoritative encoder. Bounded batch allocation while online.
2. **Upload authorization as a separate operation** over an existing reservation: reissuing an
   expired credential keeps the same object ID and AAD, revalidates consent and session state, and
   is refused after registration or session close.
3. **Receipt/status lookup** so a client that lost a response can learn registration state without
   inferring from local flags.
4. **Capability bootstrap**: versioned server limits — media format, target chunk duration, max
   envelope bytes, max chunks, remaining aggregate plaintext budget, capture-lease expiry,
   reservation window, upload concurrency. Clients hard-code none of these.
5. **The capture-lease**: short-lived (15-minute default per ADR 0016's accepted defaults),
   renewable only through revalidation, required before recording starts.
6. **One versioned capture-protocol source.** Promote `encode_envelope` and the AAD encoders into a
   versioned protocol module that yields the Python implementation and a generated/pinned TypeScript
   implementation, with **cross-language golden vectors** committed and tested on both sides. If full
   code generation is disproportionate, a single spec + two thin implementations is acceptable only
   with the vectors pinning both; propose which in the ADR and say why.

Every mutation gets HTTP-level PostgreSQL/RLS tests and a cross-process idempotent-retry test, per
the existing harness. Migrations reversible. OpenAPI regenerated.

## Phase 2 — Capacitor scaffold (`apps/capture/`)

1. Latest stable Capacitor (record the exact version and why), TypeScript, `ios` and `android`
   platforms added and synced (`npx cap sync` clean). Choose the minimal web layer deliberately —
   this is a recording appliance, not a content site; justify the framework choice (or vanilla
   TS + a small component lib) in one paragraph in the app README.
2. Consume the Phase 1 protocol package; run the golden-vector suite in TypeScript CI.
3. The durable chunk state machine from ADR 0016 — `reserved → encrypted → uploading → uploaded →
   registered → purged` — on an encrypted local store, persisting reservation, envelope, digest,
   byte length, and idempotency keys atomically. **Never** a SAS URL, Entra token, raw DEK, patient
   display value, or Blob path.
4. A mock BFF (local dev server) implementing the Phase 1 contract shapes so the whole flow runs
   locally; unit tests for the state machine covering timeout-as-unknown-success replay, expired-URL
   refresh for the same reservation, and the two-concurrent-uploads/backoff/`Retry-After` rules.
5. CI job for lint, typecheck, unit tests, and `cap sync --dry-run` on both platforms.

## Phase 3 — Recording flow and crypto (the product)

The end-to-end flow, in order, each step gated on the previous:

1. **Consent.** Clinician-facing consent capture producing the all-party consent record via the BFF
   (`POST` consent → session). Consent language must state plainly: all parties must consent to
   recording; the visit is recorded and transcribed to draft clinical documentation; recording can
   be stopped at any time. Recording controls stay disabled until the server has accepted consent,
   created the session, bound the DEK, and issued the capture lease.
2. **Key custody.** Fetch the public JWK through the BFF; generate the 32-byte DEK with the OS
   CSPRNG; wrap with RSA-OAEP-256; bind; wait for the immutable receipt. On a rotated-version 409:
   one refresh + rewrap with a new idempotency key. DEK at rest protected by a non-exportable
   Keychain/Keystore key, this-device-only, backup excluded.
3. **Recording.** Native audio capture producing PCM16 WAV chunks at the capability-endpoint format
   and duration — custom Capacitor plugin if needed (rule 12). Microphone permission flows with
   proper `NSMicrophoneUsageDescription` / `RECORD_AUDIO` declarations. Always-visible recording
   indicator with elapsed time and remaining-budget warning (the server budget is ~35 min mono —
   surface it, never truncate silently). Handle interruption sources: calls, route changes, lock,
   background limits — pause visibly, never fake continuity.
4. **Encrypt-then-queue.** Per reservation: unique 12-byte nonce, AES-256-GCM with the server AAD,
   complete envelope written to the encrypted queue **before** any network I/O; nonce and ciphertext
   never regenerated for that object.
5. **Upload + register.** Envelope `PUT` to the edge URL; register with SHA-256 over the complete
   envelope and exact byte length; retries send the identical stored bytes. Register only after Blob
   accepts; retain the envelope until the registration receipt; purge per policy after.
6. **Complete → status → transcript.** `complete` when every channel has a contiguous registered
   sequence; then poll/refresh transcription status through the BFF and render the transcript
   read-only when ready. Local history shows metadata only: date, duration, status — no patient
   names, no transcript text cached beyond the active authenticated view.
7. **Error states**: offline banner + queued-upload drain, lease expiry pause, consent revocation
   stop, quota stop, sign-out purge. Each is a designed screen state, not a toast.

UI: mobile-first, clinical-professional, one-hand operable. Big record control, unambiguous state
(idle / recording / paused / uploading / processing / ready), progress that reflects the real queue.
No decorative animation over PHI-adjacent screens.

## Phase 4 — Platform BFF (master repository)

This phase lives in the **master platform repo**, not this one. Implement the BFF surface ADR 0016
specifies: PKCE auth for the native client, per-operation user/practice/encounter authorization,
the workload-identity call to Scribe, response stripping (no internal endpoints, resource IDs, or
tokens), per-user/tenant/session rate limits on grant issuance, and the JWK pass-through with
`key_version` caching. Independent tenant allowlists and kill switches for web and native. Same
review gates as this repo. Report the PR link; it will be reviewed separately.

## Phase 5 — Upload edge, activation gates, and the manual checklist

1. Terraform for the Azure Front Door Premium private-origin upload edge per ADR 0016, false by
   default, in this repo's staged-flag style. The synthetic acceptance suite — real `PUT` through
   the edge while the storage public endpoint stays denied, private-path read-back and envelope
   verification, SAS/query/path log-scrubbing proof — before any client tenant flag is enabled.
   If a gate fails, fall back to the API-mediated gateway per the ADR and say so.
2. Produce `docs/MOBILE_ACTIVATION_CHECKLIST.md` — every step that cannot be done from code:
   - Azure portal: Front Door private-link approval, BAA/service-eligibility confirmation for every
     service in the new path, diagnostic-scrubbing verification.
   - Entra: the native app registration for PKCE (public client, redirect URIs), scopes.
   - Xcode: signing, capabilities (background audio if claimed), `NSMicrophoneUsageDescription`
     copy, TestFlight setup.
   - Android Studio: signing config, keystore custody, foreground-service + `RECORD_AUDIO`
     declarations.
   - App Store privacy nutrition labels and Play Data Safety forms — health data, audio,
     encryption-in-transit/at-rest declarations, and the export-compliance encryption question.
   - Store-review notes for a medical recording app (demo account with synthetic data only).

## Things not to do

- Do not call Azure AI Speech, Azure Storage, or Key Vault from the client, ever.
- Do not put any Azure SDK, connection string, account key, or Entra client secret in the app.
- Do not wrap the current `/upload-grant` in client-side workarounds — Phase 1 replaces it.
- Do not enable any tenant flag, edge route, or clinical capture; everything ships gated false.
- Do not add analytics, crash reporting, or third-party scripts to the capture surfaces.
- Do not touch the custody design, RLS, staged flags, canonicalizer, or test harness.
- Do not start Phase N+1 inside Phase N's PR.

## Report back per phase

1. The full gate output (Python suite with PostgreSQL, ruff, pyright, guards, OpenAPI, tofu; plus
   the TS gates from Phase 2 on).
2. Phase 1: the golden vectors, and the cross-language test proving Python and TypeScript produce
   byte-identical envelopes and AAD for the same inputs.
3. Phase 3: a device-simulator run log of the full flow against the mock BFF, and the interruption-
   matrix results (call, lock, route change, kill-and-relaunch mid-queue).
4. Anything not completed and precisely why; every decision needed from me as a specific question
   with options and a recommendation.

---

Supporting context: `CODEX_BACKEND_REVIEW.md` (seven review passes), ADRs 0009/0011/0016, and the
active backend round in `CODEX_NEXT_PROMPT.md`.
