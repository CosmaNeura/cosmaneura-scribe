# Store XPC authenticated admission

Tier 2: this changes the implementation of an existing native security boundary.

The signed Store diagnostic returned OSStatus 100001 from the service's fixed
`SecCodeCheckValidity` call for a received Bridge message. Apple's Security
implementation maps that to Unix errno 1 (`EPERM`). The failing call cannot
provide admission in that sandbox; the precise internal denied operation was
not observed. This change starts from merged 106, not the unmerged 107 status
probe.

Use one `xpc_connection_set_peer_lightweight_code_requirement` call per
connection. The service requires the Bridge's exact signing identifier, Team,
TestFlight/Development/App Store signing class, and Boolean-true sandbox and
inherit entitlements. The Bridge requires the selected service's exact signing
identifier, the same Team/classes, and Boolean-true sandbox entitlement before
accepting its reply. Missing, false, or non-Boolean values do not match.

These are authenticated incoming-message/reply policies. They do not establish
pre-delivery authentication of the initial outbound descriptors. Parent identity,
kernel parent/generation checks, Swift host identity revalidation, role claims,
descriptor grammar, SourceFence ownership, stop and drain remain unchanged.
There is no status-driven fallback or mixed requirement-setter family.

The XPC distribution now requires macOS 14.4 in parent and service metadata,
the Bridge build, and the generated auth package. The C requirement API also
refuses admission below 14.4. The shared direct package and dormant direct
metadata retain their existing minimums and behavior.

Primary basis: [Apple's XPC authentication guidance](https://developer.apple.com/forums/thread/681053),
the public `xpc/connection.h` documentation, and
[Apple's constraint grammar](https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints).
Entitlement query operation 5 matches the actual Boolean type and value. The
`$and-array` grammar combines the repeated entitlement facts. Signing categories
2, 3, 4 mean TestFlight, Development, and App Store.

Qualify the actual requirement construction and failure paths with focused
synthetic boundary fixtures; separately preserve parent guard equivalence and
compile the changed C/link inputs. This source evidence does not qualify the
kernel policy in a signed runtime, later parent checks, auth, recording or save.
Independent exact-source review precedes production build/signing/runtime.

Recovery: retain the existing signed 106/107 artifacts and receipts. Withdraw the
new Store candidate if qualification fails; do not fall back to denied manual
peer validation, loosen claims, change Keychain groups, or activate the direct
app's credentials or data.
