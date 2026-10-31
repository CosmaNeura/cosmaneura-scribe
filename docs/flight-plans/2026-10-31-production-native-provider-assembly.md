# Production native provider assembly — Tier 2

The existing production native bridge validates the organization, issuer,
audience, receiver and policy receipts, but its renderer rejected the production
Core origin. Return an explicit production profile from that guarded bridge and
require it before the renderer accepts `https://app.cosmaneura.com`. A staging
response cannot select production, and a production profile cannot select the
staging host. Consent, session validation, capture and storage remain behind
their existing native guards.

Keep the default profile projector and assembler disabled. The explicit
`--enable-clients` projection option and assembler
`--production-inputs ... --production-native-build-receipt ...
--enable-production-clients` option create enabled local client profiles only.
They use the existing closed production receiver configuration and exact
organization/workspace/issuer/audience/policy/deployment receipts. They do not
enable or deploy the receiver, change an Azure setting, grant access, install,
launch, sign or submit a client. Never supply invented production values or
treat the resulting unsigned assembly as a qualified release.

The production assembler binds every helper's actual bytes and packaged path
to those explicit inputs. It requires the desktop native build receipt to
select the production compile definition, exclude virtual-lab network support
and retain the exact identity/transport source hashes. Receipt evidence still
needs the actual build, signing and installed-runtime checks. The iOS bridge
must be rebuilt with `SCRIBE_PRODUCTION_ORGANIZATION` and without
`SCRIBE_VIRTUAL_LAB_NETWORK`; an enabled plist cannot substitute for that native
compile. Final iPhone and Mac packages must retain the production profile and
the qualified helper hashes after signing.

Receiver-first release order: qualify the existing Core production resource,
database/schema, identity/network and receiver configuration; freeze the real
production bindings; build the production native helpers and current renderer;
project and assemble the explicit enabled client profiles; sign and verify the
exact packages; run the authorized production sign-in/capture/Save/reopen/
playback/dashboard canary; submit the qualified final packages to Apple. Zoom
qualification is owned by the CTO under the October 31 scope decision.

Before release, discard this source change or use disabled profiles. After a
separately authorized release, stop new admissions and processing and drain
in-flight work before withdrawing runtime access or deploying a compatible
disabled client. Preserve saved records, consent, audit data, ciphertext,
schemas and existing resources. Do not redirect a production client to staging
as recovery, disable organization claims, restore broad permissions or delete
data. Apple distribution and any tester notifications remain separate actions.
