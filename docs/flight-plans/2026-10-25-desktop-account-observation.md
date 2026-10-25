# Desktop account correlation metadata

Tier 2, scoped to read-only auth metadata. Owner: the Scribe virtual-lab integration
work of October 25, 2026. The requested normal multi-account native journey needs
to prove that the native account matches its isolated hosted dashboard session.
The current desktop helper and renderer protocol expose phase and revision, but
no stable account identifier; a display name cannot establish this correspondence.

The native helper now includes optional `accountIdentitySHA256` only for a ready
state with an actual native identity. It is lowercase SHA-256 of the exact UTF-8
Clerk user ID. It excludes session ID, organization, profile names and tokens. The
normal desktop session projection retains only a well-formed digest in the ready
phase. The value is correlation metadata, never an authorization input, grant,
consent receipt or replacement for native session revision checks.

Existing helpers remain compatible: an absent digest stays absent. Non-ready
states and malformed metadata cannot qualify as account proof. No extra auth
request, token access, native listener, permission or account membership is added
to the product. The iOS public auth payload is unchanged. This patch changes no
receiver, database, deployment setting or production environment.

Validation uses the actual native hashing function in the existing offline native
auth/transport check, including a known UTF-8 digest, account change, sign-out and
zero token reads. Capture protocol tests exercise ready replies/events, legacy
helpers, invalid digests and every non-ready phase. Capture and desktop typechecks
and focused lint cover the additive optional field. Offline results are separate
from normal-login and rebuilt-client acceptance.

After independent final-head review and merge, rebuild and sign the owned desktop
candidate from that merged source and record its exact bundle inventory. The lab
must observe the digest from the candidate's normal UI auth flow and match the
expected isolated hosted account; a manually supplied digest does not pass.

Recovery is to select the previously reviewed owned candidate only after its
capture is confirmed idle and saved, or revert this additive patch and rebuild.
An older helper cannot pass the new lab identity gate. Do not replace, terminate
or modify a potentially recording installed app to exercise this change. No
database or deployed data rollback is involved.
