# Store native startup diagnostics

Tier 2. Owner: Scribe founder. Scope: diagnostic development of the distinct
Mac App Store application; no identity, permission or admission changes.

The signed Store104 launch failed while opening its auth service. Its fixed
Bridge category9 combines XPC errors, and the native service can return or
cancel at several unobserved admission gates. The source does not establish
which gate failed. This change identifies a failing boundary without changing
the guard, result, cancellation, descriptor or native stop contract.

## Fixed observation contract

The Bridge keeps its bounded stderr grammar. Category13 means
`XPC_ERROR_CONNECTION_INTERRUPTED`, category14 means
`XPC_ERROR_TERMINATION_IMMINENT`, and category9 remains other XPC errors.
Categories10–12 retain their existing meanings and exit70 is unchanged.
The bootstrap decoder and runtime diagnostic writer accept exactly1–14.

Native messages use only compile-time literals at error visibility in the
fixed `com.cosmaneura.scribe.store.bootstrap` subsystem. They contain no
request, descriptor, PID, identity, path, credential, OS error description,
authentication result or clinical data. No debug logging setting is enabled.

| Category / literal prefix | Codes |
| --- | --- |
| `container` / `SCRIBE_STORE_CONTAINER:` | 1 unapproved build;2 self-code lookup;3 dynamic validity;4 static translation;5 signing-info call;6 signed-info/role identity shape;7 exact membership;8 OS group URL;9 canonical URL;10 directory open;11 stat;12 UID/mode |
| `auth-entry` / `SCRIBE_STORE_AUTH_ENTRY:` | 1 entry;2 container accepted;3 plist refusal;4 listener handoff;5 entry catch;6 owner construction attempted;7 owner constructed;8 owner construction refused;9 request construction refused |
| `listener` / `SCRIBE_STORE_SERVICE:` | 1 peer requirement setter;2 duplicate/exclusive/active limit;3 effective UID;4 authenticated signed Boolean;5 fixed open decode;6 kernel-parent/host signature;7 capture busy;8 reply creation;9 worker dispatch;10 pre-admission XPC error;11 listener entry;12 listener configuration refusal |

The C listener uses a saturating atomic32-message budget per process. Container
messages identify failure only. Auth entry/constructor messages have no
per-frame logging and retain the service's existing one-owner admission.
Logging neither supplies authority nor turns a diagnostic into an error.
Guard conditions retain their order and short-circuit behavior; membership
errors are rethrown unchanged. Descriptor close, cancellation and completion
ordering remain intact.

Use the first positive ordered message, keeping category distinctions.
`SERVICE:10` can follow a prior cancel and a budget can suppress later events.
Missing messages do not prove a gate passed or a service was ready.

## Qualification and recovery

Focused checks cover new Bridge subtype acceptance, malformed/out-of-range
inputs and first-failure retention. Source equivalence records the unchanged
membership, parent, peer and stop bodies outside repository mirror tests.
C syntax and Swift type/parse checks qualify source compilation only.

Root owns the separately reviewed fixed-subsystem observation, canonical
host and fresh four-native producer, signing, exact signature audit and one
bounded normal startup. Service unified logs are not captured by Bridge
stderr. The collector must match only these category/literal pairs and retain
closed numeric evidence; it must not export general system records.

The current signed Store104 candidate and its failed startup evidence remain
preserved. Rebuild only from merged, reviewed source. Recovery is retention
of the prior artifacts and refusal of unqualified promotion; no credential,
container, singleton or source-fence deletion is part of this change.

Apple SDK `xpc/connection.h` defines interrupted as remote exit before a reply
and documents that a send barrier completes sending rather than client reply
receipt. This change does not claim to qualify sender-exit timing, SDK/auth,
Keychain, sandbox, XPC admission, capture, saved review or coexistence.
