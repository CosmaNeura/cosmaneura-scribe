# Scribe stable checkpoint — 2026-09-23

Work is stopped at the owner's requested checkpoint. The full operational beta is incomplete. The persistent goal is paused. No additional deployment, Git commit, push, PR, or cross-task coordination is authorized by this checkpoint itself.

## Verified release state

The current September 23 staging candidate is already deployed:

| Component | State |
| --- | --- |
| Shared Core | `cosmaneura-staging-app--0000018`, image `sha256:8fefe5d01540d0633a957fc59567e3bb27b0cdbe43330568903c2d4e7fb54bdf` |
| Native receiver | `cosmaneura-staging-scribe-native--0000007`, image `sha256:bfd1c23ac58204089d5fcdd7d66e72aece51e0fd9e37aa85f1fd7e5098296fea` |
| Scribe API | `cosmaneura-staging-scribe-api--0000003`, image `sha256:b6560a83449d0bc8a98d3b97c99c48776126e0c568b2c27ec969928e58f240cf` |
| Workers/schema | Existing speech/translation jobs on API3 image; schema `0023_unstarted_retirement` |
| iPhone | Signed development build 9 installed and launched; owner confirmed one synthetic encounter |
| Mac | Same-identity signed update installed at `/Users/jw/Applications/Cosmaneura Scribe Beta.app`; normal app restores the encounter and retained preparation |

Azure revision numbers identify deployments, not a unified product version. The three applications were last checked Running with their latest revisions Ready at approximately 19:27 UTC. Shared-Core release configuration and identity fingerprints were preserved. Public entry: https://scribe.cosmaneura.com; shared Core frontend: https://staging-app.cosmaneura.com.

Selected release manifest:
`/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/operational-release-assembly/admission-renewal-staging-20260923/release-manifest.json`
SHA-256: `e211b0c4fe4b861187991a638c917d5965dc3e032a8739416e420fca6b61a280`.

## Completed in this checkpoint

- Core18 repairs the missing `aiohttp` async managed-identity transport. Existing installed package versions are preserved; the real packaged Core workflow factory constructs and closes. That offline check is not installed admission acceptance.
- Receiver7 recognizes only the authenticated, bounded Core consent-required refusal, rechecks authorization, and emits a fixed code.
- Both native clients sanitize that exact admission conflict. The Mac internal bridge now carries the same fixed code to the renderer.
- Preparation recovery first submits null consent with the retained request key. Only the exact refusal offers an unchecked confirmation. Explicit confirmation renews the timestamp without changing the original encrypted local journal. A lost reply is recovered using null consent and the retained key.
- The installed Mac displayed that renewal screen and submitted the owner's confirmed consent. Both installed platforms have reached the authorized synthetic encounter list.

The user supplied “US-East, confirming participant agreement and consent.” The supported country `US` is retained with the original wording preserved. No state was inferred. Consent and prior identity, signing, workload and staging approvals are fulfilled; do not ask for them again.

## Exact unresolved operational failure

The original synthetic admission is retained in Core:
`scribe_admission_01m37vjgjjf4ybv68w12h7t8f5`.

After the latest installed recovery attempt, Core reports `consent_unconfirmed`, `last_error_code=scribe_phase_unconfirmed`, with no attached consent ID or session ID. The Scribe database has exactly one matching consent, `f258b096-eb2a-4296-a26c-5dadda0c1c3e`, with all-party consent true and no revocation. There is no Scribe session, recording, chunk, transcript or saved note from this encounter.

This localizes the failure to completion/confirmation of Core's consent phase. The underlying cause has not been established; do not describe it as a proven timeout or fixed integration. An explicit recovery attempt also failed. Do not repeat unchanged retries. Next work should expose the bounded error at the actual Core consent-call/receipt boundary, diagnose it, and preserve the existing operation and downstream idempotency key.

Evidence:
- `/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/installed-workflow-observer-20260923/core-after-consent-recovery-001.json`
- `/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/installed-workflow-observer-20260923/scribe-after-consent-recovery-001.json`
- `/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/admission-renewal-20260923/desktop-bridge/installed-renewal-result.json`
- `/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/admission-renewal-20260923/signed-ios/visible-workspace-result.json`

The Mac remains open at the unconfirmed preparation screen. It has not started recording. The iPhone was last owner-confirmed at the encounter list. Its local capture workflow has not been exercised.

## Validation and limits

Targeted checks passed: 5 receiver cases, 3 client cases, 5 desktop bridge cases, six compiled native sanitizer cases, and one compiled UI scenario covering unchecked confirmation, immutable intent and lost-reply recovery. Capture and desktop type-checking and changed-file lint passed. Final whitespace checks passed. No completed provider trials were replayed.

At checkpoint, all 31 release receipt references and the eight-file final source manifest verified. The installed desktop exactly matches the signed package inventory. The desktop/iOS native sanitizer source mirrors match. Protected service authentication and capture authority source hashes are unchanged. The builder is stopped and temporary registry credentials were removed. Prior installed packages and older release receipts are preserved.

Installed recording → encrypted upload → processing → creator review → saved/reopened Core note remains unverified. Installed process-loss recovery also remains unverified. Those are launch requirements, not acceptance implied by local fixtures or signatures.

The metadata-only Scribe observer cannot directly select normalized working transcripts with the API role. It reports that table as unavailable. Do not expand database grants merely for this observer. One Core connection diagnostic stopped at its endpoint guard before token or network calls; it provides no authentication failure evidence. Later verification of the actual stored consent made speculative authentication probing unnecessary.

## Source and parallel staging integration

Existing Scribe checkout/branch preserved:
`/Users/jw/Desktop/Cosmas/cosmaneura-scribe-beta-preintegration-20260904`, branch `codex/beta-preintegration-20260904`, HEAD `56cc215b0ececfe12375c78c50efd84f897e2b10`.

Owned shared-Core candidate: `/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/core-candidate`.
Owned native candidate: `/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/candidate/apps/capture/native-plugins/cosmas-native-auth`.
Current admission packet: `/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/admission-renewal-20260923`.

No Git index, commit, push or PR was created. Preserve unrelated dirty files, original read-only source trees and all documented approvals. Do not contact another task for coordination. Before a later combined staging release, inspect local source and the deployed revision/image/configuration again. If session-preparation work advances shared Core, integrate against that newer state; do not redeploy the old Core18 image over it. The current receiver7 and native fixes are already installed/deployed and can be retained while the remaining Core phase is repaired.

Stop at this checkpoint until the owner resumes the work. The full Scribe goal remains incomplete.
