# Approved local staging amendment — 2026-09-22

The owner explicitly approved: “I approve applying the reviewed local staging
patch.” All four patches in
`/Users/jw/Desktop/Cosmas/scribe-staging-core-proposal-20260922.91bkvt9u/README.md`
are now applied to their exact reviewed targets. Do not request that approval again.
The original review packet is retained unchanged as historical approval evidence.

Application receipt and backups:
`/Users/jw/Desktop/Cosmas/scribe-staging-core-applied-20260922.z772bqch/`.
`application.json` binds the four patch hashes, original/resulting hashes and targets.
The existing Scribe checkout/branch remains based on
`56cc215b0ececfe12375c78c50efd84f897e2b10`; these changes are local and uncommitted.

## Applied scope

- Seven native auth/bridge files in the owned approved iOS source copy now support
  the exact `core-staging-personal-v1` identity and public HTTPS transport profiles.
- Two files in the copied receiver identity source add the verifier mode and
  reviewed personal-provider correspondence model. This is not the Core checkout.
- Scribe's provider receiver and transport are updated, and the default-off ACA
  ingress adapter is added. Existing creator/encounter authorization stays authoritative.
- The owned `StandaloneBuildProfile.plist` selects Cosmas Development's
  `resolved-emu-53` issuer and the proposed receiver endpoint. Native auth remains
  **disabled**, with minimum iOS **17.0** and the already approved standalone bundle.

Thirteen files across the four application targets changed exactly as reviewed.
The SQL remains a proposal: no database migration, account insertion or shared-data
write ran. Configuration IDs remain unset. No endpoint was created, runtime enabled,
app signed/installed/launched, or cloud resource changed. Earlier iOS build and
Electron dependency/install approvals remain intact.

## Verification

Before application, all 263 original inputs and the review artifact hashes matched;
all four patches passed `git apply --check` before the first source mutation.
After application, the complete native/identity component file hashes and all Scribe
patch output hashes match the tested review candidate. The profile parses and stays
disabled. Six focused checks against the actual applied import paths pass, covering
profile boundary rejection and the unrelated native-synthetic mode guard. They use
an empty offline JWKS cache and no database, network, Keychain or device.

Existing candidate evidence remains applicable to the identical applied bytes:
53 receiver/RSA/owned-PostgreSQL checks, five final configuration guards, 43 native
profile checks, and iOS 17-targeted native-auth/bridge compilation. Completed live,
physical and W13 trials were not repeated. This is local source/fixture evidence,
not installed acceptance. The post-apply check initially needed its fake key provider
to permit the verifier's initial cache refresh; only that fixture was corrected.

Core's head and all 82 pre-existing dirty paths remain unchanged. Both protected
Scribe authority hashes are preserved. W13, Mac R2, installed applications and their
credential/TLS/database resources were not changed. The separately prepared desktop
start-order, Core capture-schema and dashboard source-selection patches remain
unapplied; this approval does not cover them.

Subsequent independent preparation added a native picker/indicator IPC patch at
`/Users/jw/Desktop/Cosmas/scribe-native-presentation-20260922.qlcx7mog/README.md`.
Its separate Cocoa helper and main-process transport compile for macOS 14.2.
Twenty checks pass: 14 actual Swift-pipe cases using an invented audio-free surface
and six provider-factory cases. The GUI helper was not launched. This packet and
its window-before-authority dependency remain unapplied; the final standalone
host/backend factory, physical GUI/capture acceptance and orphaned-warning restart
reconciliation remain unfinished. No additional staging/account access occurred.

A further unapplied client-ordering patch is prepared at
`/Users/jw/Desktop/Cosmas/scribe-prepared-start-20260922.jdwecl5w/README.md`.
It reuses the existing Core creator-review read before preparation, requests a
desktop grant only after the lease/deadline are saved, preserves that lease after
a lost grant reply, and skips start grants for confirmed-upload recovery. Twenty-two
local checks pass with native audio stubbed. Its initial failures exposed a mock
reservation-deadline discrepancy; the mock now matches the existing Scribe backend.
The paired durable desktop/mobile start-authority contract remains unimplemented.
This packet does not change the approximately 60% operational-beta estimate.

## Technical build outlook

Engineering estimate: **about 60% complete toward operational beta**, with a
**55–65% uncertainty range** and **3–5 weeks of focused engineering remaining**,
assuming prompt staging/account, signing and device access. This is an estimate
of the complete operational deliverable, not a percentage of tests or source files.

The capture/transcription/translation/review components, encrypted local recovery,
Core contracts, provider UI and dormant native shells are substantially built.
The main remaining implementation is their operational integration: actual
desktop native/backend factory, device key custody, presentation IPC and durable
server-issued start authority; staged Core capture release; receiver/workload/
worker/storage configuration; and verified provider/encounter mappings.

The approved staging profile removes one configuration incompatibility. The later
authorized Clerk read verified `john@cosmaneura.com` in the selected staging issuer:
the email is primary and verified, and the account is neither banned nor locked.
The credential's issuer was checked by a public/authenticated JWKS match. The
organization-membership endpoint returned HTTP 403; memberships were not verified,
and that response does not establish that none exist. No session or account change
was made, and the credential was not stored or printed.

The Core actor/tenant/practice and capture-provider mappings remain unverified.
The exact staging-only read is prepared at
`/Users/jw/Desktop/Cosmas/scribe-staging-provider-read-20260922.97g0690m/README.md`.
It has not accessed its separate database credential or connected to PostgreSQL.
Existing authorization names only `Staging / clerk-staging-api`; the database
credential/read needs its own approval. The read would establish mapping facts,
not complete clinical authorization or installed acceptance. This account result
does not change the approximately 60% overall estimate.

Remaining schedule ranges, with some packaging work parallelizable:

1. Complete runtime/host integration and the first isolated shared-Core workflow:
   approximately 1–2 weeks, dependent on the remaining exact application/release scope.
2. Physical desktop/mobile capture, restart/logout/revocation/offline recovery,
   iOS 17 compatibility and bilingual fidelity through the actual Core SOAP flow:
   approximately 1–2 weeks including fixes.
3. Signed installation/update/rollback, onboarding and operating acceptance:
   approximately 0.5–1 week. Signing or platform-specific failures can extend this.

The full goal remains active and incomplete. A signed standalone app performing
the entire authorized encounter-to-Core-note workflow has not yet been accepted.
