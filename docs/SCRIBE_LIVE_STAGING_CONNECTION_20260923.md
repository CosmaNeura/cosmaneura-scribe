# Live Scribe staging connection — September 23

Current desktop authentication recovery update — September 23: the selected
release is `operational-release-assembly/desktop-auth-stop-staging-20260923/release-manifest.json`.
It adds `desktop-auth-stop-recovery-20260923/desktop-staging` and retains signed
iOS build 7 plus the deployed continuation services/schema. Desktop native proofs
survive authentication change in memory for same-account cessation only. Main
cleanup, explicit sign-in and renderer acknowledgements are connected even when
a preparation reply was lost. Three native and two compiled UI/main/preload
scenarios, ten affected tests, types/lint and complete desktop build pass.

No persistent proof, new identity, signing, installation or service change was
applied by this increment. The exact desktop proposal is rebound unchanged and
still awaits its answer. The practice target also remains pending. Process-loss
recovery still needs a concrete exact-scope proposal; earlier references to a
pending policy must not be read as an already implemented or reviewable packet.
The detailed five-file patch and evidence limits are in
`desktop-auth-stop-recovery-20260923/README.md`. This remains local fixture/build
evidence, distinct from installed end-to-end acceptance. Earlier selections
below are retained history.

Current continuation update — September 23: schema `0022_source_position`, API
revision `0000002`, native receiver revision `0000005`, Core revision `0000016`
and both worker image references are applied. The final deployed Core-to-API
readiness and all nine workload-token checks pass; receiver registry startup
and Core authorization pass. Settings, identities and worker schedules are
preserved. The temporary database firewall rule was removed.

The current selected release is
`operational-release-assembly/continuation-staging-20260923/release-manifest.json`.
It selects corrected `capture-continuation-20260923/desktop-staging-r2` and
`signed-ios-r2` (iOS build 7). The provider Pause/Resume controls, encrypted
continuation and truthful multiple-start evidence are connected through the
existing Core note path. Owned fixture, compiled native/UI, full build/signing
and deployed component checks pass. This is not installed physical acceptance.
The detailed results, initial failures/corrections and recovery are in
`capture-continuation-20260923/README.md` under the owned follow-up directory.

The existing practice-target and exact desktop identity/install questions remain
pending. The desktop proposal is rebound to the selected package without any
scope change and remains unapplied. Persistent native proof/process fencing is
also unapplied. No client was installed or launched; no completed provider or
device trial was repeated. Earlier build and image references below are history
unless explicitly carried forward by the current release manifest.


The owner resumed continuous operational work and granted blanket approval for
intermediate staging blockers, explicitly including the Azure prefix and both
workload grants. Those approvals are fulfilled. Historical proposal files and
approval flags are retained as history, not new permission requirements.

The existing Scribe branch remains `codex/beta-preintegration-20260904` at
`56cc215b0ececfe12375c78c50efd84f897e2b10`; unrelated changes are preserved.
Original Core/OS/native trial checkouts and protected authority files remain
unchanged. No cross-task coordination or completed provider/device trial replay.

Completed in real staging:

- The approved AI account prefix and exact Core→Scribe / receiver→Core workload
  role assignments were applied and verified once. Foundation A's missing
  translation endpoint/DNS was added by a separate successful operation; all
  43 declared resources are now accounted for. The original failed operation
  remains historical and was not resubmitted.
- Three selected immutable images were published. The API and receiver were
  deployed in the existing app environment; separate Speech and translation
  jobs use the new private worker environment and dedicated identities.
- Entra PostgreSQL access, two new Scribe databases, restrictive runtime roles,
  31 Scribe tables at `0021_source_stop`, and six registry tables are provisioned.
  John's reviewed registry account exists. Temporary desktop firewall rules
  were removed. There are no capture sessions or encounter workspace bindings.
- Eight Core migrations were applied in one transaction to revision
  `c8526f5e8d80`. The owned Core image is deployed with the dedicated caller
  identity and Scribe workflow configuration. Existing caller/configuration is
  retained. Actual Core→Scribe health/readiness and all nine real workload-token
  checks passed.
- Receiver startup with its actual managed identity, restricted registry reader,
  and Clerk verifier passed. Real receiver→Core workload authentication passes;
  Core correctly returns `CONTEXT_REQUIRED` without a user mount. The configured
  receiver's Azure transport-header correction is deployed at revision
  `cosmaneura-staging-scribe-native--0000004`. Actual public ingress accepts both
  native origins while requiring identity, and rejects absent/unapproved origins,
  cookies and forwarded-header injection. Transport metadata is stripped without
  changing request-path authority; no temporary diagnostic remains in the image.
- Both real worker jobs completed their first empty-queue runs successfully:
  `scribe-staging-speech-q7jrf4e` and `scribe-staging-translation-2tvvsdz`.
  This verifies runtime construction and database discovery, not inference.
  Their subsequent read-only network executions also succeeded, with the exact
  executed script verified from Azure: private DNS/TLS to the provider and vault,
  managed-identity public wrapping-key reads, and Speech's private ciphertext
  container read. No inference or capture-data write occurred.
- First inference through the newly deployed private worker identities also
  passes: Speech recognized the pinned, consented synthetic 4.017-second sample
  with zero reference word errors and explicit English phrase evidence; the
  unchanged source normalizer accepted it. Translation returned HTTP 200 and a
  valid pinned-model/schema response for one invented nonclinical Spanish
  sentence. Each adapter was invoked once. These are new staging-binding checks,
  not replays of historical trial executions or native acceptance. They made no
  database/blob/encounter/review writes and left both worker definitions intact.
- `scribe.cosmaneura.com` now has a DNS-only CNAME to existing staging Core,
  an ownership TXT record, and an Azure-managed TLS certificate. Existing DNS
  records and HTTPS aliases are preserved. Its exact Core host-list addition is
  applied; TLS, health, homepage and the visible Core/Clerk sign-in page pass.
- Core's workflow/capture/notes and the Scribe API's configured capture path are
  enabled for the isolated qualification. API/worker tenant lists contain only
  `2813a696-740d-4c7a-97c3-04f60fdd26ef`. All three apps' intended revisions are
  ready and running. Both workers now automatically poll their existing pending
  queues every minute. Their first scheduled executions succeeded without manual
  starts. Current consent, durable claims, bounded retries, dedicated identities,
  image, resource limits and the single-tenant list remain unchanged.
- New desktop and unsigned iOS staging copies contain the verified receiver,
  exact ciphertext upload origin and enabled native/provider configuration.
  Only three configuration files changed; executables, renderers and original
  packages are unchanged. The desktop still retains Electron's root identity.
  These copies are neither signed as Scribe nor installed or launched.
- A separate iOS development copy is now signed with the existing Apple
  certificate and wildcard profile for team `JVV65668U6`. Both embedded XML and
  DER entitlements match the exact approved Scribe identity and its own keychain
  group; deep/strict signature verification passes. No new certificate/profile,
  Apple portal mutation or installed-app change occurred. This is a registered
  iPhone development package, not TestFlight/App Store acceptance.
- The iOS logout recovery correction is assembled as signed **build 5**. On
  authentication change, native capture is fenced while the original volatile
  proof is retained solely for stop. Fresh authentication must match the original
  account/organization before that stop request can be sent. The app permits
  explicit sign-in for cleanup while the old workspace remains closed; this
  control is enabled only by the iOS host. Native session/gate/transport checks,
  11 compiled app checks, types/lint and the complete iOS archive/signature pass.
  SDK/remote/audio ports in local checks are fixtures. No proof persistence or
  process-loss recovery is introduced. Build 4 and the desktop package remain
  preserved; build 5 has not been installed or launched.
- A read-only check inside deployed Core confirms John's exact account has one
  valid note template and its existing `gpt-4.1-2025-04-14` model endpoint is
  configured and TLS-reachable. This is a separate Core model endpoint from the
  translation worker. No model inference or clinical-record access was requested
  by that readiness check.

John's existing Core access is valid through an existing pilot grant; no grant
was created or expanded. He has no practice membership. The unique existing
`cosmaneura.com` practice is `Cosmas MD` with an existing owner. The prepared
workforce/provider/synthetic-encounter binding awaits clarification that this
is the intended practice; the owner, BAA, billing and attestations will not be
rewritten. No practice or synthetic encounter binding has been applied. The
complete two-phase Core/registry operation is prepared with stable IDs, bounded
transactions, preserved owners/grants and idempotent exact-result recognition.
It requires the actual practice-target confirmation before execution.

The exact new desktop root identity `com.cosmaneura.scribe.beta.desktop`, existing
certificate signing and separate local installation/launch packet is prepared.
Its question remains pending under the owner's explicit exact-scope identity
approval rule. The five proposed plists and executable packaging operation are
reviewable without changing the app. Azure/source/iOS approvals are fulfilled.

Operational acceptance still requires the complete isolated staging encounter
→ physical capture → upload → actual processing → explicit creator review →
Core SOAP/dashboard path, native identity lifecycle/recovery, and signed desktop
and iOS installation. Existing local fixture evidence remains distinct from
those outcomes. Cohort/PHI activation is not performed. The physical iPhone was
unavailable at the last read-only device inventory; this upload increment did not poll it again. The existing Apple
development signing identity is available; no new signing identity was created.

The PostgreSQL bootstrap tooling received operational fixes for Azure's
principal-list column, new-role creator grants, UPN handling and platform-admin
default privileges. Ordinary unexpected DDL creators still fail the checked
permission guard. The published API image predates these administrative-tooling
changes; do not claim its bootstrap tooling matches the current source.

Current receipts are indexed under:
`/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/`
in `staging-runtime-connection-20260923`, `postgres-staging-execution-20260923`,
`core-staging-connection-20260923`, `receiver-activation-20260923`,
`worker-activation-20260923`, `worker-network-qualification-20260923`,
`worker-provider-qualification-20260923`,
`receiver-ingress-correction-20260923`, `capture-runtime-activation-20260923`,
`clients-staging-20260923`, `ios-development-staging-20260923`,
`desktop-identity-review-20260923`, `worker-scheduling-20260923`, and
`public-hostname-review`, `core-note-readiness-20260923`, and
`ios-auth-stop-recovery-20260923`.

The preceding upload-retry release selection was
`operational-release-assembly/upload-retry-staging-20260923/release-manifest.json`.
Preceding selections are retained unchanged as history. Its selected iOS artifact
was `upload-retry-20260923/signed-ios` (build 6); prior builds remain retained.
The latest normal-context CoreDevice check still reports the paired iPhone as
unavailable. The sandbox inventory timeout was not treated as device-state proof.
No owned builder, fixture database, remote shell or signing process remains
running locally. The deployed worker schedules remain active as part of the
approved staging workflow. The full goal remains active and incomplete; no installed acceptance
is inferred from local packaging or cloud service checks.

September 23 upload-recovery update: the shared provider screen now offers
explicit Retry upload after confirmed native stop/server retirement and a
temporary upload/completion failure. It reuses the retained encrypted recording
and completion key through the existing lifecycle/desktop IPC operation; it
never restarts recording or renews authority. Access denials and terminal queue
failures retain the recovery error. The complete iOS archive is signed as
build 6 with the existing approved identity/certificate; its native source and
profiles retain build 5's logout correction. Desktop JS/view is rebuilt with
unchanged native helper executables/profiles. The desktop identity proposal is
rebound to the current source in `upload-retry-20260923/desktop-identity-review`,
with byte-identical proposed plists and no expanded identity/install scope.
Both identity packets remain unapplied; no client was installed or launched.

Seventeen encrypted-flow/local HTTP checks, four compiled workspace checks,
eleven compiled application checks, types/lint and full iOS signing pass.
Native/audio/session/Core ports remain fixtures. The detailed incremental patch,
preimages and recovery are in `upload-retry-20260923/README.md`. This closes
same-screen upload recovery; it does not implement capture continuation,
persistent owner proof, or installed end-to-end acceptance.
