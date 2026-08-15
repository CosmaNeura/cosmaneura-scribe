# Prompt to push to Codex

Final, 2026-08-15, written against open PR #5 (`agent/scribe-transcription-job` at `2db0624`) and
`main` at `d57d721`. Paste everything between the rules. It replaces the standing operating
instructions, not `CLAUDE.md` — `CLAUDE.md`'s hard rules still bind.

---

PR #5 is good work and PR #4 before it was the strongest in the series. The dormant job gate holds
under probing — with the enable variable unset, garbage arguments produce a fixed code, construct
no clients, and echo no value into any log. The transcription database role grants exactly what the
worker calls and nothing more. The Terraform validations prevent the enable-without-deploy case and
cross-check the Speech endpoint against the resource ID. And `infra/README.md` already documents the
two hardest operational traps: that the Key Vault key is a data-plane resource a public GitHub
runner cannot create, and that the migration job must be re-run so bootstrap maps the new identity.
Keep all of it. Merge PR #5 — nothing below blocks it.

Four findings have been open across earlier rounds and you have not seen them until now. They are
small and they come first.

## Standing rules for this and every following round

1. **Fix before you extend.** A known reproducible defect outranks any new slice. Do not build on
   top of one, and do not work around it in new code — if new code needs a constraint that existing
   code is missing, fix the existing code.
2. **A slice is not done until the behavior is proven on the path that runs in Azure.** For anything
   touching persistence, that means an HTTP-level test against real PostgreSQL with RLS and triggers
   active. You have applied this well; keep it.
3. **Never introduce a second definition of a rule.** Legal state transitions, field constraints, and
   status vocabularies are defined once in Python and generated into SQL and OpenAPI.
4. **No unhandled exception may reach a client.** Every route returns a declared status code.
5. **Assume every request is a retry, and that the previous attempt hit a different process.**
6. **A README "What works now" bullet means a user can do the thing.** Say "implemented, not yet
   activated" when that is the truth — as you already do.
7. **When you cannot verify something, say so** in the commit body and in your reply. State exactly
   what you executed and what it printed.
8. **Report blockers instead of routing around them.** Put them at the top of your reply as a
   specific ask with the exact decision needed.
9. **An assumption about an Azure role, API, or CLI flag is not verified until something real
   returned the expected answer.** A passing test against a fake proves the code, not the platform.

## 1. The four carried corrections

- **Pin the v1 transition table.** Migration 0005 calls `render_transition_predicate()` at run time,
  so the SQL it emits depends on current code rather than an authoring-time snapshot. Two databases
  that both report `0005` applied can carry different triggers if anyone edits
  `SESSION_STATUS_TRANSITIONS`, and nothing would flag it. Add a test pinning
  `render_transition_predicate()` and `render_status_values()` for v1 to hard-coded expected strings,
  so editing v1 fails CI and forces the v2 plus new-migration path. Do not re-derive the expected
  value inside the test. Keep the existing 49-pair parity test; it proves the rendering is faithful
  but cannot catch this, because both sides derive from the same mutable source. Also make migration
  0005's `downgrade` symmetric — it restores the trigger but not the status CHECK constraint.
- **`EncryptedAudioTrackReader.path` is missing `field(repr=False)`.** Every sibling field has it,
  including `AudioTrack.local_path`. The path carries no patient identifier, so this is not an active
  leak, but it contradicts ADR 0011's own "never include object paths" invariant.
- **`httpx.ProtocolError` is uncaught** in `audio_keys.get_public_key`,
  `KeyVaultSessionKeyUnwrapper.unwrap`, and `handoff.py`. All three catch `AzureError`,
  `TimeoutException` and `NetworkError` only, so a malformed response becomes an opaque 500 rather
  than a typed code. Fix all three.
- **State the assembly duration limit in minutes.** The 64 MiB plaintext ceiling accumulates across
  all channels, not per track — roughly 35 minutes of 16 kHz mono audio, or 17 minutes of a
  two-channel virtual visit. The transcription job sets no
  `COSMANEURA_SCRIBE_AUDIO_ASSEMBLY_MAX_PLAINTEXT_BYTES`, so the default is what will run against
  `memory = "1Gi"`. Put the number in minutes into ADR 0011 and `docs/TRANSCRIPTION_WORKER.md`, decide
  deliberately whether to raise the setting for the job, and make the limit an acceptance criterion
  before any pilot. A visit that fails assembly at minute 36 is a bad way to discover this.

## 2. Verify the platform assumptions before anything is enabled

This is the highest-risk unverified thing in the repository, and no test can catch it.

The whole client key-wrapping flow depends on `Key Vault Reader`
(`21090545-7ca7-4776-b22c-e363652d74d2`) being sufficient for `GET /keys/{name}` to return public
material. If it is not, `GET /v1/audio-encryption-key` returns 503, no client can wrap a session DEK,
and nothing downstream works. Every current test uses a fake client, so CI will stay green either way.

- Confirm each of the five role GUIDs resolves to the role you intend — Key Vault Reader, AcrPull,
  Storage Blob Data Reader, Key Vault Crypto User, Cognitive Services Speech User. Paste the actual
  output.
- Make one real `GET /v1/audio-encryption-key` call from the deployed API with only Key Vault Reader
  assigned, and paste the result. If Reader is insufficient, say so and propose the narrowest role
  that works — do not silently widen to Crypto User, which would give the API unwrap permission.
- Add the propagation note the activation sequence is missing: step 4 creates three data-plane
  assignments and flips the enable variable in one apply, so the first execution can 403.
- Dry-run the documented start command. Confirm
  `az containerapp job start --container-name worker --args <tenant> <session>` *merges* with the job
  template rather than replacing the container spec; if it replaces, `--image` and `--command` are
  also required and the runbook is wrong.
- Add one runbook line: do not run the database migration job while a transcription execution is
  active. `_grant_transcription_permissions` revokes before granting, and PostgreSQL evaluates
  privileges per statement.

## 3. Finish the infrastructure that has been carried since the first review

`infra/` moved this round for the first time. Close the rest of it.

- Drop `sensitive = true` from `subscription_id` and `tenant_id` in `infra/variables.tf`. Sensitivity
  propagates, so `tofu plan` prints `(sensitive value)` for exactly the Container App settings your
  runbooks require an operator to eyeball. They are identifiers, not secrets — your own onboarding
  doc says so.
- Add diagnostic settings on the storage account and Key Vault. Blob and key data-plane access to
  PHI is unaudited while PostgreSQL has full diagnostics. This one matters more now that a second
  identity can unwrap session keys.
- Add `ALTER DEFAULT PRIVILEGES` to the bootstrap. You have hand-added grants for four new tables in
  a row.
- NSGs on the private-endpoint and Container Apps subnets.
- Reconsider Log Analytics `daily_quota_gb = 0.5`. Silent ingestion loss past the cap is how an
  incident becomes invisible.

## 4. Retention

Still the one P0 responsibility in `docs/PLAN.md` with zero implementation in either the service or
`infra/`: no lifecycle policy on the audio container, no deletion path for audio, transcripts,
delivery receipts, or job rows.

The design now makes cryptographic erasure the natural primitive — deleting one `session_audio_keys`
row makes that session's audio permanently unreadable. Note that the runtime role has `SELECT` and
`INSERT` on that table and no `DELETE`, which is correct: erasure needs its own principal and grant.
Do not widen the runtime role. Propose the policy with an ADR before implementing, and cover key
rotation in the same document — the code already supports per-version unwrap, but nothing says how
long a rotated key version must stay enabled. The answer is until every session bound to it is
transcribed or erased.

## 5. Then the remaining activation work

- **Speech.** Provision the private Azure AI Speech account, its private endpoint and DNS, and run
  one live round-trip of `AzureSpeechTranscriber.from_settings` on synthetic audio. Every current
  test uses `FakeAzureClient`, so the real client construction and wire shape are still unverified.
- **The delivery reconciler.** It still has no trigger. Attach it to the same mechanism you chose for
  the transcription worker, behind its own false-by-default flag.
- **The client upload path.** ADR 0009 commits to web and mobile capture clients, but the audio
  container has `public_network_access_enabled = false` while `/upload-grant` returns a SAS URL on
  the public blob endpoint, and `GET /v1/audio-encryption-key` sits behind the platform workload
  identity so clients cannot fetch the wrapping key directly either. Write the ADR for the whole
  client path — upload, key retrieval, and chunk encryption — before any client work starts.

## Things not to do this round

- Do not start the capture clients. `apps/web-capture` and `apps/mobile-capture` stay READMEs until
  the full client path has an ADR.
- Do not add environments, regions, or peering.
- Do not enable `enable_transcription_job` until section 2 is verified.
- Do not mark `docs/PLAN.md` items complete. Report status in your reply; I will update the plan.
- Do not touch the credential model, the RLS policies, the staged-flag structure, the leased worker
  design, the canonicalizer, the test harness, the audio key custody design, or the dormant job gate.
  They are right.

## Report back with

1. Every command you ran and its actual output — `pytest` with the PostgreSQL-backed endpoint runs,
   `ruff`, `pyright`, `check_phi_logs`, `check_secrets`, `check_adr_numbers`, `generate_openapi`,
   `tofu fmt -check`, `tofu validate`, `tofu plan`.
2. For section 1: the v1 pinning test failing against a deliberately edited transition table, then
   passing on revert.
3. For section 2: the actual role-definition output and the actual response from the live
   `GET /v1/audio-encryption-key` call. If you could not run them, say so plainly and do not mark
   the section done.
4. Anything you did not complete, and precisely why.
5. Every decision you need from me, phrased as a specific question with the options and your
   recommendation.

---

Supporting evidence and file-level detail: [`CODEX_BACKEND_REVIEW.md`](CODEX_BACKEND_REVIEW.md).
