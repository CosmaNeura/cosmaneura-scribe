# Store signed-peer admission diagnostics

Tier 2: the change observes an existing native security boundary. It does not
change admission, identities, entitlements, profiles, credentials or recording.

The bounded Development105 observation reached auth entry and listener startup,
then listener stage 4 before descriptor decoding. The client reported an
interrupted connection. Stage 4 combines received-message code creation,
dynamic validation, static translation, signing-information retrieval and two
strict signed Boolean checks; those markers do not identify the failing call.

Keep stage 4 as the first refusal and append one fixed detail:

| Detail | Failed check |
| --- | --- |
| 13 | Received XPC message code reference |
| 14 | Dynamic code validity |
| 15 | Static code translation |
| 16 | Signing-information retrieval |
| 17 | Information dictionary absent or malformed |
| 18 | Signed entitlements dictionary absent or malformed |
| 19–21 | Sandbox Boolean missing, wrong type or false |
| 22–24 | Inherit Boolean missing, wrong type or false |

A failed Security API also appends one class selected from public SDK constants:
25 access/not-verifiable, 26 unsigned, 27 object/parameter/format, 28
signature/trust/change, 29 requirement, 30 resource, 31 unavailable code, or 32
other. No raw status, error text, value, path, identity, PID or request field is
logged. Shape and Boolean refusals have no API class. The existing literal-only
OSLog vocabulary and saturating 32-event process budget remain; absence or
truncation never proves a gate passed.

The received-message identity, dynamic validity, two signing-information reads,
strict CFBooleanTrue checks, parent and peer requirements, kernel-parent checks,
descriptor close, cancellation and worker stop/drain order remain. The fixed
detail is an output of the guard and provides no admission authority. Direct
distribution and Store host/runtime setup are unchanged.

Apple's [SecCode API header](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/SecCode.h)
supports received XPC dictionaries and requires validation before trusting
disk-derived signing information. Its
[implementation](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/SecCode.cpp)
uses the associated connection's audit token. The
[disk representation](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/diskrep.cpp)
uses a bundle heuristic, while Apple's
[CF bundle implementation](https://github.com/apple-oss-distributions/CF/blob/main/CFBundle.c)
checks the declared executable against the requested executable. These sources
do not establish that the embedded Bridge was confused with its parent at
runtime, so no identity or entitlement workaround is introduced.

Qualification uses the existing C boundary fixture with synthetic public
Security/process seams and real CoreFoundation values. It verifies first
failure details/classes, strict missing/false/non-Boolean refusal, no subsequent
Security calls after failure, two reads on success, and payload non-authority.
Compiler and existing focused Python results are bound to the frozen source;
the fixture does not activate an XPC service or qualify signed runtime behavior.

Promotion requires independent review of the final source SHA, actual merged
tree equality, a separately reviewed canonical native producer and actual
signature audit. Reuse of the 105 host requires all declared source inputs and
all host output bytes to match. Root owns the next bounded signed launch and
exact-scope collector; runtime, login, storage and capture remain unqualified.
Recovery retains every 105 artifact and receipt and can revert this source
change before another release; it never deletes locks, credentials or app data.
