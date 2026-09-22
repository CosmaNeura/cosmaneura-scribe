# Standalone Scribe iOS identity — proposed 2026-09-22

Status: prepared for the owner's decision; **not approved or applied**.

Subsequent read-only reconciliation found that existing staging Core uses
`https://resolved-emu-53.clerk.accounts.dev`, while this exact proposal retains
W13's `sharp-bluegill-3253` issuer. Approval of the bundle patch below does not
authorize an issuer change and does not establish shared-Core authentication.
Prepare a separately reviewed staging identity/account amendment before connection;
see [the Core release packet](SCRIBE_CORE_RELEASE_PACKET_20260922.md). The original
patch and qualified native inputs remain unchanged.

The existing native configuration accepts only CosmasOS synthetic app identities.
A separate Scribe application therefore needs one exact additional iOS identity.
The complete provider startup now reuses the current native sign-in/session owner,
provider receiver connection, recorder host and capture/review/Core workspace.
This packet addresses its native identity configuration; it does not claim that
the still-missing full runtime or an installable package is ready.

## Exact local change

Apply the three-line [proposed patch](../../scripts/standalone-provider/standalone-identity.patch)
only to a new owned copy of the qualified iPhone native auth package. Allow the
exact bundle `com.cosmaneura.scribe.beta` for `capacitor://localhost`. Keep the
existing native token validation, sign-in/out, deadlines, SDK driver and secure
storage implementation unchanged. No wildcard Scribe prefix is allowed.

| Setting | Selected value |
| --- | --- |
| App display name | Cosmaneura Scribe Beta |
| iOS minimum | 17.0 |
| Bundle identifier | `com.cosmaneura.scribe.beta` |
| Native callback | `com.cosmaneura.scribe.beta://callback` |
| Clerk test frontend | `https://sharp-bluegill-3253.clerk.accounts.dev` |
| Existing test organization | `org_3IonFhWeRdI0H9nOPcuyXiqqbmv` |
| Existing receiver audience | `cosmas-os-beta-api` |
| Native bridge origin | `capacitor://localhost` |
| SDK secure-storage service, derived by unchanged driver | `com.cosmaneura.scribe.beta.clerk` |
| Logout access-block service, derived by unchanged implementation | `com.cosmaneura.scribe.beta.workspace-auth` |
| Capacitor logging | `none`; receiver bridge enforces disabled logging |

Reuse the existing test publishable key from the qualified iPhone source, SHA-256
`17eb888255eca2a2a53df45b4ee209d878c0942274d21e52f6172d54fb3f95dc`.
No secret or session token is copied. Sign-in uses the existing account and native
Clerk flow, including emailed-code sign-in. This app has its own secure storage;
W13 credentials and its accepted session are not migrated or shared.

Qualified input package:
`/Users/jw/Desktop/Cosmas/scribe-w13-native-session-20260922.6ass20w_/iphone-source/apps/capture/native-plugins/cosmas-native-auth`.
The original `NativeClerkConfiguration.swift` SHA-256 is
`c16405fe99f900d2c36bf699bf6f4bd9a9f482e205ecf750ab99211e610bc5e0`.
Refuse changed input before preparing the copy. Never apply this patch to W13,
Mac R2, OS/Core source or the older installed Cosmaneura Capture app.

## Qualification and recovery

After approval, qualify the exact new bundle/callback and reject near-matching
bundle IDs, the desktop origin and production Clerk keys. Keep the accepted W13
configuration valid. Compile the new native composition with the iOS 17 target
and the retained dependencies. Bind source/artifact hashes in the build receipt.
No new dependency or account is selected by this packet.

Recovery is to leave the new source/package unused. Preserve all previous apps,
secure-storage items, ACLs, certificates, running receivers and retained records.
There is no Keychain reset, credential migration or shared schema change.

## Remaining activation boundary

This request permits the exact local native configuration change and build
preparation. It grants no Core/OS auth policy edit, production credential, MCD
cohort activation, new live-service campaign or shared/cloud configuration write.

The provider receiver still needs the reviewed real Core origin/workload source,
creator/account/encounter correspondence, ciphertext upload target and existing
Core creation/navigation routes. Those must be concrete and verified before the
complete app can be installed and accepted on the phone. The W13 two-route
receiver cannot be used as that clinical backend. Its completed sign-in/catalog
trials will not be repeated as proof of the new workflow.

The owner-requested boundaries in
[handoff section 4](../SCRIBE_HANDOFF_20260921.md#4-non-negotiable-deconfliction-and-authority)
say: “New schema/auth/consent/environment/service/release scope requires approval.”
The earlier W13 build-4 installation grant covered that exact W13 profile. This
separate Scribe bundle/callback is the additional auth configuration under review.
