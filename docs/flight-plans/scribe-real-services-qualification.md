# Scribe real service and client qualification

Owner direction: 2026-09-21. Work toward one standalone Scribe capability used by
both its own clients and CosmasOS. The priorities are real authentication/token
custody, real STT/model/Spanish-to-English services, physical iPhone acceptance,
source fidelity, and reproducible signed artifacts.

## Boundaries and reuse

Use the existing local, unpushed `codex/beta-preintegration-20260904` branch
(starting at `1e48c12`, descendant of the authorized `b46ade8`). Inspect newer
CosmasOS/Scribe integration sources read-only; their uncommitted work belongs to
other ongoing work. Do not open a PR, push, change staging/IAM/Zoom, or deploy
under this packet. No cross-task coordination.

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

Current observations: the physical iPhone 12 is paired, iOS 26.7, Developer Mode
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
