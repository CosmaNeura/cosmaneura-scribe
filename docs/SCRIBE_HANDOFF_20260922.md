# Scribe continuation checkpoint — 2026-09-22

## Latest checkpoint

See [the September 24 committed checkpoint](SCRIBE_COMMITTED_CHECKPOINT_20260924.md)
for current source, staging comparison, validation and remaining acceptance work.
The September 22 handoff below is retained as historical scope and approval evidence.

Read this file completely. It is a bounded handoff at the owner's requested
stopping point, not a declaration that beta is complete. Verify local Git state
before editing. Preserve the full goal and boundaries below; do not import the
old conversation, restart trials, or contact another task. Documented historical
device/service observations are not assertions about their current state.

## Goal and owner decisions

Deliver operational standalone desktop and iOS 17+ Scribe for MCD providers:
authorized existing Core encounter → consented physical capture → real STT →
Spanish-to-English translation → explicit creator review → existing Core SOAP
and creator/dashboard encounter. Complete native identity lifecycle, physical
recovery/capture, fidelity and signed installation/operations acceptance.
Libraries, diagnostic apps and invented fixtures are progress, not operational beta.

The owner explicitly decided:

1. Existing Core owns users, workspaces, encounters, SOAP notes and dashboard records.
2. Scribe processing runs alongside it in existing infrastructure, with its own
   worker capacity, encrypted recording storage and access controls.
3. Scribe and CosmasOS use the same reviewed integration and existing encounter.
4. Qualify isolated test data before enabling the provider cohort.

Read `beta/SCRIBE_SHARED_CORE_DECISION_20260922.md`. Do not repeat the earlier
environment architecture question. Actual deployment/configuration is still open.
Prior approvals cover local Core integration, configured admission/Core SOAP and
the complete local capture → review → existing Core creator flow. Specific W13
build/receiver/launch grants do not approve a new standalone identity or runtime.

## Checkout and authority

- Work only in `/Users/jw/Desktop/Cosmas/cosmaneura-scribe-beta-preintegration-20260904`,
  branch `codex/beta-preintegration-20260904`. Use the existing branch/checkout.
- Parent checkpoint is `6a8fee93415c49d9429ece98553706aa6578cc0c` (ADR 0060).
  The commit containing this file adds ADR 0061; obtain its exact hash from Git
  and `desktop-host-checkpoint.json` in the evidence directory below.
- Read the applicable root/repository `AGENTS.md`, `CLAUDE.md`, and the product
  reference `/Users/jw/Desktop/Cosmas/d3-compact-proof-worktree/docs/reference/cosmasos-beta/START_HERE.md`.
  Historical insurance-only pilot scope is not the current product goal.
- No task/chat/project/agent coordination: do not send, poll, fork, hand off,
  create another task or solicit status. The owner requested a handoff prompt only.
- No push, PR, merge, deployment, cloud writes, shared DB writes, PHI or cohort
  activation. Core/OS checkouts remain read-only. Preserve unrelated changes.
- New dependencies/services, auth/session/environment and release changes need
  the exact missing scope reviewed. Prior explicit grants persist; do not repeat them.
- Preserve `services/api/src/cosmaneura_scribe/service_auth.py` SHA256
  `3520432d8211faa7eeef151342a7300c3ec5f776b481af6834d54f6e510e15b0` and
  `apps/desktop-companion/src/capture-authority.ts` SHA256
  `c78a649181fd740ecd4e04b5a6ad8d0ad3d246332056ab956c3fa6f3979ab19a`.
- Mac R2 is unchanged: no rebuild, resign, restart, Keychain diagnostic, reset,
  ACL or namespace change. Preserve W13 build 4, its private receiver/TLS/PG and
  other installed apps. Do not replace installed CosmaneuraCapture.
- Do not repeat completed live Speech/translation trials or accepted W13 checks.
  Clerk user JWTs never become Entra workload authorization.

## Latest implementation and evidence

Read `adr/0061-packaged-desktop-provider-host.md` and the newest section of
`beta/SCRIBE_PROVIDER_WORKSPACE_20260921.md`.

Evidence directory: `/Users/jw/Desktop/Cosmas/scribe-desktop-host-20260922.3e7wlxvy/`.

The new dormant Electron composition verifies four fixed renderer assets,
installs the existing sandbox/security and main/preload boundary before showing
the full provider workspace, and retains native ownership through stop/quit
failures and late startup results. Cleanup clears protected UI immediately.
`scripts/build-desktop-provider-host.mjs` emits main/preload/UI and hash receipts;
`host-build-final/host-build.json` explicitly reports `launch_ready: false`.

**There is no installed Electron runtime or actual provider-host.mjs factory.**
The declaration `standalone/provider-host.d.mts` is not an implementation.
The factory still needs approved native session/backend configuration, real
picker/indicator, device key custody, stores, helper and Core/upload/navigation
profile. A compiled host package with this missing module is not a runnable app.

Current verification:

- 75 desktop checks pass in `desktop-regressions.log`, including six host checks.
- Desktop types and main/preload checkJs against actual Electron 44.4.3 declarations
  pass; final workspace/script lint passes (`types-r3.log`,
  `electron-types-final.log`, `lint-final.log`).
- `host-build-final.log` and `compiled-preload-ui-final.log`: build and three
  full compiled provider UI/main/preload checks pass. These cover sender rejection,
  explicit review, journaled Core SOAP editing/navigation and revocation clearing.
- Capture source is unchanged from 6a8fee9: prior 202 capture, three recorder DOM
  and ten application checks remain applicable and were not repeated this turn.
- New checks use invented native/backend/content data; Electron itself was not
  launched. Existing generated-audio Swift pipes and SQLite regressions passed.
  No physical recording, real Core request or completed live trial ran.

Electron 44.4.3 is a concrete **unapproved, unapplied** proposal. Read
`beta/SCRIBE_DESKTOP_RUNTIME_PACKET_20260922.md` before any dependency action.
An exact external patch and lock receipt exist; seven package entries are added
without changing existing package versions. No runtime binary was downloaded or
installed. npm's first metadata-only attempt failed because both config paths
were `/dev/null`; unique empty configs fixed it. No unresolved test failure remains.

## Core release gap — first integration dependency

Read-only Azure metadata located production `app.cosmaneura.com` /
`chat.cosmaneura.com` and existing staging equivalents. It did not qualify their
clinical routes, credentials, health or dashboard behavior.

The production app's observed mutable image tag names commit
`8fa02a71f4b880cd43f4fccc8c81c92a0d635623`. That local Git object lacks seven capture
route/config/service/model files present in the dirty local Core checkout.
See `core-production-metadata.json`, `core-staging-metadata.json` and
`core-tag-commit-comparison.json`. This is source-associated evidence, **not proof
of the running immutable image contents or route configuration**.

Core read-only checkout: `/Users/jw/Desktop/Cosmas/cosmas-os-core-integration`,
HEAD `e21ba4c1fb1027de8123aca9b8aee25b8a11b612`, pre-existing dirty tree.
Do not point clients at production assuming local capture routes are deployed;
do not deploy this dirty tree. Reconcile exact image/configuration and prepare
the bounded receiver-first Core promotion/configuration packet. Shared hosting
alone does not qualify recording/transcript association in existing dashboards.

The prepared iPhone transport currently requires a pinned RFC1918 IPv4 HTTPS
receiver on port 1024–65535. It cannot simply use the public Core hostname/443.
Prepare the mobile receiver/access profile and provisioned Core mappings; review
any extension of that trust boundary before changing it. The receiver does not
create encounters or provide the missing upload/Core navigation callbacks.

## Already completed; preserve and reuse

- ADR 0048: local complete provider controls, capture/review/notes/creator flow.
- ADR 0049–0053: standalone Core transport, mixed capture recovery, separate
  default-off provider receiver, native receiver bridge and application lifecycle.
  Native HTTPS/offline JWT/local PG and compiled UI checks passed; the new receiver
  and standalone iOS app were not activated/installed.
- ADR 0054–0057: real Swift microphone/system producer, host-clock mixer, encrypted
  PCM/WAV flow and actual Swift/Node pipe transport. Generated audio/backpressure/
  stop retry/parent loss passed; physical recording is unqualified.
- ADR 0058–0060: durable encrypted SQLite queue/keys/journals/coverage with generated
  SIGKILL/WAL recovery; recorder authority/lease/indicator composition; full desktop
  provider backend/review/note UI bridge. Actual device custody remains missing.
- Qualified generated helper:
  `/Users/jw/Desktop/Cosmas/scribe-desktop-native-pipe-20260922.eMXizG/pipe-fixture-final`,
  SHA256 `8d1b27ad9e4d6dbb4f563af3a4e98ba10c080673853de64d79f23a45edb7dc53`.
  Reuse for unchanged local checks; this is not production physical-source acceptance.
- W13 build 4 (`com.cosmasos.synthetic.w13`, 1.0/4) physically passed invented
  encounter loading, signed-in restart, logout clearing, signed-out restart and
  fresh emailed-code sign-in. Do not repeat those steps. W13 is a diagnostic,
  not the complete standalone Scribe app.
- Durable W13 inputs: `/Users/jw/Desktop/Cosmas/scribe-w13-native-session-20260922.6ass20w_/`.
  Prior phone: iPhone 12, iOS 27; this does not establish iOS 17 compatibility.
  Last-known private receiver `https://192.168.1.36:8446`, PG socket port 55462,
  TLS directory `/Users/jw/Desktop/Cosmas/scribe-w13-private-20260922.WDvYrR`;
  leaf expiration September 29. These were not revalidated this turn; preserve them.

## Pending decisions and next critical path

The separate iOS identity packet remains unanswered and unapplied:
`beta/SCRIBE_STANDALONE_IOS_IDENTITY_PACKET_20260922.md` and
`scripts/standalone-provider/standalone-identity.patch`.
It proposes `com.cosmaneura.scribe.beta`, a separate SDK namespace and unchanged
qualified native SDK/configuration. Prior W13 launch approval does not cover it.
Do not repeat the pending question before reviewing its exact packet and context.

Work in this order while completing independent approved local work:

1. Reconcile existing Core release/integration and prepare isolated account,
   workload, storage and phone-reachable receiver configuration. Obtain only the
   missing concrete scope; keep existing Core record ownership.
2. Finish actual desktop/mobile hosts and native/backend factory, with approved
   identities/runtime, real picker/indicator/key custody, then exercise the full
   encounter → capture → review → existing Core note/dashboard workflow.
3. Accept native refresh, logout, revocation and identity continuity in both
   standalone hosts. Reuse W13 evidence where applicable without relabeling it.
4. Accept physical recording, interruptions/offline recovery, iOS 17 and desktop
   Meet/Zoom capture, including explicit consent/authority and truthful coverage.
5. Evaluate end-to-end bilingual fidelity through existing Core SOAP using isolated
   fixtures; do not rerun completed service smoke trials as a substitute.
6. Complete signed distribution, installation/update/rollback, onboarding and
   operating acceptance before cohort enablement.

Do not inflate readiness based on fixture count. The last rough planning estimate
was 55% (45–65% range), 3–5 weeks with configuration/device access; it was not a
measured acceptance result. Reassess against the release gap and remaining hosts.

## Local tooling and stopping point

Node 24: `/Users/jw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.
npm 11.5.2 CLI: `/Users/jw/.npm/_npx/dc836f55b75a12b7/node_modules/npm/bin/npm-cli.js`.
Reuse repository dependencies and proportionate tests. The compiled UI harness
accepts provider bundle, compiled main IPC, existing jsdom API and optional built
preload. Its prior commands/logs and Electron typecheck config are in evidence.
No tool/test process should be left running at the checkpoint.

The originating chat had a requested timebox of approximately 15 more minutes,
then a handoff prompt to reduce context drift. That chat stops at this committed
checkpoint/receipt and pauses its incomplete goal. When the owner pastes the
continuation prompt into a new chat, resume the critical path above; the old
timebox does not limit the resumed work. No chat was created or contacted.
Older approval/history details remain in `SCRIBE_HANDOFF_20260921.md` and linked
ADRs; consult only what the next concrete action needs.
