# ADR 0058 — Retain desktop capture and provider recovery state

Date: 2026-09-22

Status: local main-process persistence implemented; native custody/host uninstalled

## Provider outcome and decision

Desktop capture now has durable encrypted stores for its existing flow, queue,
provider/review journals and native coverage. A forced process exit after actual
Swift-fixture capture leaves recoverable ciphertext and session-key state. The
existing flow reopens it as paused, without starting a source, then uploads once
and reaches configured processing. This is the local recovery capability needed
by the provider host; the installed application is still unfinished.

Use Node 24's built-in SQLite module, with an explicit owner-private directory,
FULL synchronous commits and WAL. There is no added package, database service,
shared schema migration or plaintext fallback. The new version-1 local file
format has an application ID; unknown formats/versions fail closed. Interrupted
initialization of a genuinely empty database can be retried; a missing sentinel
in a versioned store is an error and never creates a replacement key.

The trusted host supplies the server-bound creator/environment recovery scope,
workspace ID and a stable, non-extractable AES-256-GCM key with encrypt/decrypt and
wrap/unwrap usages. The store never generates, resets or writes that key to disk.
Its eventual native device-custody binding remains a required packaging step;
the CryptoKey type alone does not prove device custody. No Keychain item, service,
ACL, namespace or authentication implementation was accessed or changed here.

The directory/file checks require a canonical non-symlink path, current Unix
ownership, mode 0700/0600 and regular, single-link database files. Existing
permissions are never silently changed. This is the current macOS/Linux file
profile, not Windows ACL acceptance or protection against a hostile same-user
filesystem race. Windows and signed/native operating acceptance remain open.

## Reuse and atomicity

Files and record indexes use digests of opaque scopes/keys. AES-GCM additional
data binds the recovery scope, namespace, record key and revision. A sentinel
detects the wrong or missing custody key even before record access. Plaintext
record buffers clear after sealing/opening. SQLite receives ciphertext, nonces,
digests and revisions; it never receives raw audio, raw session keys or the root
key. Temporary SQL storage stays in memory. Framework/kernel copies and immutable
JavaScript strings are outside the mutable-buffer clearing claim.

Create/compare-and-swap use atomic SQLite statements. Related completed-flow
deletions share a guarded transaction. Flow rules are reused from the existing
IndexedDB implementation, and queue data uses its existing validated codec and
state revisions. The store snapshots mutable incoming state before asynchronous
work. It does not introduce a second upload/encryption/consent state machine.
All namespaces are selected by trusted main code, not renderer arguments.

Browser/iOS session-key behavior remains the default. An optional trusted-host
key factory lets desktop add local wrapping inside `createWrappedSessionKey`,
while the existing temporary key is already available for RSA wrapping. Only
encrypted local wrapping and the original non-extractable encrypt-only key leave
that helper; raw key material is not exposed through a new callback. The default
return shape and RSA/Core binding body are unchanged when local wrapping is absent.

Desktop commits local key wrapping and its pending/bound state together in one
encrypted record. It accepts only candidates produced by its own factory and
bound to the selected session and server wrapping; an ordinary non-extractable
CryptoKey cannot silently become an unrecoverable disk record. Restoring unwraps
an encrypt-only, non-extractable key. No non-extractable key is exported or made
extractable to persist it. Callers must pass `flow.createSessionKey` to their
main-process `CaptureFlowController` along with `flowStore: flow`.

`desktopJournalRecords` reuses the current provider/review journals through their
existing narrow record interface. It is not a Capacitor plugin registration or
renderer storage API. Coverage persists an immutable attempt start and optional
completion. Missing completion survives reopening as incomplete coverage; a
partial audio chunk still follows ADR 0057's in-memory/drain rules.

## Verification and remaining host work

Tier 2: capture/key custody. Continue ADRs 0054–0057's authorized local,
invented-data flight plan. Recovery leaves this implementation unmounted and
preserves all existing stores/apps; no automatic migration, cleanup or key reset
is provided.

Evidence: `/Users/jw/Desktop/Cosmas/scribe-desktop-durable-20260922.nt9C50/`.
All 57 desktop and 200 capture checks pass, including five new durable-store
checks; both workspaces typecheck and affected lint passes. The only intermediate
type error was a test Buffer API annotation; the earlier diagnostic is retained.

The new checks exercise real files, concurrent CAS from separate connections,
owner permissions, plaintext absence, wrong keys, corrupted ciphertext, scope
separation, symlink/version refusal, existing journals, incomplete coverage and
refusal of a candidate without local key protection. The process fixture uses
the qualified generated-audio Swift executable from ADR 0057, real capture/WAV
encryption, an invented-consent HTTP BFF and an ephemeral test custody key. It
SIGKILLs the writer with SQLite still open, reopens its WAL, verifies every WAV
sample, verifies the restored key against the server RSA-unwrapped key, and
resumes upload exactly once through the existing controller. The native audio
helper has already confirmed stop before that process kill; abrupt physical
capture loss and power-loss durability are not claimed.

The fixture's root key is retained by its parent, not a native key vault. Actual
device key provisioning/unlock/identity continuity, complete Core runtime,
provider main-process ownership and the renderer command/snapshot interface are
still required. The existing provider UI must consume that interface without
receiving sources, storage handles, audio keys or upload credentials. W13, Mac R2,
their private receiver and the pending standalone identity packet are unchanged.
No physical recording or completed live-service trial ran.
