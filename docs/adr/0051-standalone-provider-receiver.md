# ADR 0051 — Bind the standalone provider receiver to existing identity and Core authority

Date: 2026-09-22

Status: accepted for local source preparation and offline qualification only

## Context

The provider UI, native recorder/resource host and Core transport were implemented,
but the transport's required fresh identity/creator callback was not bound to
the existing database and authentication code. W13's successful receiver exposed
only connection health and a catalog; expanding that active receiver would mix
its accepted connection scope with a new clinical surface.

## Decision

Prepare a separate, disabled-by-default FastAPI receiver under
`scripts/standalone-provider/`. Reuse twelve hash-verified files from the retained
build-4 identity receiver without changing their verifier, model or authorization
logic. Bind the current bearer to the active external identity/human, creator-owned
workspace, confirmed Core encounter observation and reviewed Core account. Reopen
the database session for every check before/after Core I/O and final local work.

Use `ProviderCoreTransport` for fixed Core exchange/mount/binding and the three
existing configured capture/note facades. The native bearer is used only for
Core user-context exchange; a separately supplied server workload token remains
server-side. Core is still the authority for capture, session and clinical work.
No new tenant/actor claim parser, schema, database write, identity grant or token
store is added to this receiver. Native epochs cannot supply identity. Recovery
scope is derived from server-owned environment/creator/account correspondence.

The interface supplies catalog, mount, recorder reauthorization and existing
capture/review/note requests. It accepts only the exact configured HTTPS/native
boundary, rejects caller authority headers and suppresses fixed-error details.
Clinical idempotency keys pass through unchanged; the receiver never retries an
uncertain mutation. No credential is returned to JavaScript.

## Risk and local flight plan

Tier 2: a new authenticated host surface, even though retained policy code is
unchanged and the source is dormant. The owner's approved local configured
capture → review → existing Core SOAP scope covers this implementation and its
isolated invented-data checks. It does not activate a cohort, real Core runtime,
new native app profile, shared database, cloud service or deployment.

1. Preserve the installed W13 build-4 app/receiver, original private database/TLS,
   approved Mac R2, both demos, and protected Core/OS/auth paths.
2. Prepare a separate owned source copy and offline socket-only database; verify
   identity/creator revocation and current client interoperability.
3. Bind the actual native HTTP/cancellation/upload interface and existing Core
   creation/navigation. Prepare the exact Core origin, workload credential source,
   reviewed account/encounter correspondence and standalone app identity before
   any activation decision. Do not create permissive stand-ins to obtain a pass.
4. After the concrete configuration is within its authorized scope, qualify the
   real standalone app and Core flow. Retain the existing physical/auth/fidelity/
   release acceptance gates; source checks cannot substitute for them.

Recovery: leave this component disabled and discard only its owned preparation
artifacts when authorized. No active runtime was changed and no migration was
introduced. Disabling future requests cannot undo a Core mutation already sent;
the existing exact-key recovery remains necessary for an uncertain result.

## Verification and limits

Evidence: `/Users/jw/Desktop/Cosmas/scribe-provider-receiver-20260922.pnahj9UO/`.
Fourteen focused checks pass (`receiver-tests-final.log/.xml`) using PostgreSQL's
actual seven retained tables, the unchanged verifier with an offline RSA signing
key, and explicit Core wire responses. They cover native absence versus malformed
origin claims, organization/subject/expiry rejection, foreign ownership, missing
Core-source correspondence, committed identity/account/link/human revocation,
changed Core identity mapping, scope continuity, recorder session mismatch and
fixed HTTP/body boundaries. The actual TypeScript provider client completes
admission, review and note requests; save/recovery preserve the same edit and key.
Ruff, existing API strict types and the receiver/preparer's separate basic type
check pass. The isolated test cluster was stopped after validation; its files and
earlier test logs remain retained. No native app or service listener was started.

The first fixture run used a noncanonical JWKS URL; the second incorrectly parsed
Core's empty mount-resolution body as JSON; the third expected 401 where the
existing Core transport deliberately normalizes failed fresh authorization to
403. Their logs remain retained. These were offline fixture corrections, not
authentication-policy exceptions. No completed live-service trial was repeated.

This does not establish live Core/Clerk or model acceptance, a standalone native
connection, encounter creation/navigation, ciphertext transport, physical audio,
remote revocation timing, SOAP fidelity, or a signed provider release.
