# Scribe real service and client qualification

Owner direction: 2026-09-21. Work toward one standalone Scribe capability used by
both its own clients and CosmasOS. The priorities are real authentication/token
custody, real STT/model/Spanish-to-English services, physical iPhone acceptance,
source fidelity, and reproducible signed artifacts.

## Boundaries and reuse

Use the existing local, unpushed `codex/beta-preintegration-20260904` branch
(starting at `1e48c12`, descendant of the authorized `b46ade8`). Inspect newer
CosmasOS/Scribe integration sources read-only; their uncommitted work belongs to
other ongoing work. Do not open a PR, push, or change shared staging/IAM/Zoom.
The initial packet prohibited deployment; the bounded owner-approved extension
below is the only exception. No cross-task coordination.

Core remains the SOAP generator. Scribe captures, transcribes, translates the
Spanish portions, preserves source/version/speaker evidence, and hands reviewed
English working text to Core. Fidelity evaluation checks negation, numbers/units,
medications, speaker attribution, omissions and translation meaning. It does not
introduce another diagnostic model or duplicate Core's note evaluation program.

Reuse the Azure Speech adapter, translation planner/writer/review contracts,
Clerk native SDK qualification, encrypted recorder and existing Apple/Electron
packagers. Translation uses the existing GPT-4.1 family and Azure API contract.
Credentials stay server-side and are never written to source or evidence.

## Ordered work

1. Add a concrete Azure GPT-4.1 Spanish-to-English adapter behind the existing
   provider interface. Bound payloads, reject redirects/refusals/incomplete
   results, require network verification, and never automatically repeat a call.
2. Qualify fixed invented bilingual cases through an available real service;
   retain aggregate/opaque evidence and keep source fidelity distinct from
   provider connectivity. Then connect durable execution and creator review.
3. Finish the already-approved W13 native sign-in/Keychain trial using the
   selected test account. Reuse its issuer/audience/organization and explicit
   owner credential entry. Preserve existing apps and their recorded data.
4. Compile the selected iPhone candidate for the physical device; qualify
   installation, consented invented capture, interruption, restart and logout.
   Produce matching standalone/CosmasOS integration evidence.
5. Produce artifacts from recorded source/dependency inputs, verify signatures
   and installer/update behavior, and identify any unavailable distribution
   certificate/profile explicitly. A development signature is not distribution
   acceptance. Publishing/admitting testers requires its applicable authority.

## Evidence and recovery

Tier 2: protected text, credentials and cross-service contracts. Run focused
negative/recovery tests, then relevant lint/types and regression checks. This
first adapter change has no route, default setting, schema, worker activation or
environment mutation. Recovery leaves it unconfigured. Source review and exact
artifact evidence remain prerequisites to promotion.

Initial observations: the physical iPhone 12 is paired, iOS 26.7, Developer Mode
enabled; Xcode 27 reports its developer disk image cannot be mounted. One Apple
Development identity is available; no distribution identity was listed. The
owned Azure Scribe Speech resource exists in East US with public access disabled.
These observations do not prove successful capture, service inference or release.

Implementation and live evidence are recorded in
[the 2026-09-21 checkpoint](../SCRIBE_REAL_SERVICES_CHECKPOINT_20260921.md).

## Disposable storage acceptance extension

Run the existing migration/restricted-role/recovery tests against a new local
PostgreSQL cluster under an owned temporary directory, database name ending in
`_test`, Unix socket only, no TCP listener. Only invented test data is admitted.
This exercises the existing additive schema; it does not apply a migration to
the main, integration, development-cloud or production database. The existing
fixture's destructive downgrade tests are permitted only in this newly created
throwaway cluster. Stop only this cluster's verified process when finished;
retain logs/data for inspection without deleting any shared resource.

## Owner-approved private qualification extension — 2026-09-21

After connecting the iPhone, the owner stated: “You have the explicit approval
you need.” This approves the previously requested isolated Scribe private Speech
qualification setup/execution and selected native-device trial. It does not
authorize shared Auth/IAM/Zoom/staging changes, a push/PR, deployment of unmerged
code, production/PHI use, cohort admission or release publication.

Readback corrected an earlier inventory error: `cosmaneura-scribe-dev-smoke`
already runs `cosmaneura_scribe.speech_smoke_runner`, not API-route acceptance.
Its gate is false, backend is `none`, and its dedicated identity has only
`AcrPull` on the Scribe registry. Reuse this existing job. The deployed source
`eaf343a1152eccf7fff0a96652a1c3731902c30c` is a merged ancestor of the locally
recorded `origin/main`; registry readback resolves its tag to
`sha256:6ee5a221e50e284cf37d58f01746cbfe632c487c32fbcbd40158e7a713c1253c`.
The tag is mutable; do not describe it as an immutable deployment.

Run one no-override disabled-state execution, retain only fixed action/error
metadata, and verify the effective execution template. Do not treat this as
Speech inference. Enablement still requires the private acceptance runbook's
reviewed saved plan, current-state reconciliation and a qualified private
infrastructure execution path. No account/public-network relaxation or arbitrary
job command/environment override is an alternative. Leave clinical transcription
off. Removing any temporary Speech call authority follows the same reviewed plan
path, preserving the existing dormant job.

The phone must pass current unlock/developer-service and exact installed-bundle
checks before installing the preserved development package. Never overwrite an
existing unrelated app or collect a password, code or token. The W13 identity
snapshot still has capture/model services disabled and does not qualify full
device capture or a phone-reachable backend.

### Approved management-plane execution method

On 2026-09-21 the owner explicitly approved the proposed method instead of
creating another private infrastructure runner. Use this Mac only for the
authenticated, refreshed, saved Speech-only infrastructure plan. Audio execution
remains in the existing private Scribe job. This is the scoped exception to the
private-operator-location requirement in `SPEECH_PRIVATE_ACCEPTANCE.md`.

Protect the exact existing remote state before planning; keep all plans/state
outside Git, preserve locking and review current lineage/serial before apply.
The only permitted enablement changes are the existing smoke job's raw gate,
backend and owned endpoint/private-IP environment settings, plus its single
account-scoped Speech User assignment. Reject image/command/identity changes or
any API, network, key, database, shared IAM or other dependency action. Execute
the job once without overrides, verify its effective template and retain only
fixed outcome metadata. After the terminal result, use a fresh reviewed saved
reverse plan to close the gate and remove only the temporary assignment.
No new runner, unmerged deployment, PR/push, cohort activation or PHI use is
authorized. Existing image drift is retained temporarily, not silently reconciled.

Execution completed on 2026-09-21: one enabled, no-override private Speech run
`cosmaneura-scribe-dev-smoke-0wnnz72` succeeded and emitted
`speech_smoke.completed`. Both pinned synthetic cases passed the runner's 0.25
per-case WER ceiling. A reviewed reverse plan then restored the disabled job and
removed only the temporary account-scoped Speech User assignment. All 37 original
resource records and outputs match the protected snapshot; state lineage is
unchanged, serial 62 → 63 → 64. The API image/revision and private Speech network
boundary are unchanged. No trial retry or clinical activation is authorized by
this result. See the checkpoint for exact plan hashes, timestamps and limitations.
