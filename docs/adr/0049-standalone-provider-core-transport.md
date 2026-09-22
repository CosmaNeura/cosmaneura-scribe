# ADR 0049 — Standalone provider transport through existing Core authority

Status: implemented locally, unregistered and disabled by default, 2026-09-22.

The provider workspace already emits configured admission, creator review and
Core SOAP requests. Its native resource host needs a server connection that keeps
Core workload and encounter authority out of the renderer. The older read-only
OS adapter demonstrates the context exchange but lacks the current configured
admission/review contracts; selecting it unchanged would break this workflow.

`ProviderCoreTransport` is a server-side consumer of the existing Core routes.
The authenticated host must supply `fresh_context`: current normalized identity,
beta grant, creator/encounter mapping, a stable environment/creator recovery UUID,
the host authorization revision and a fresh user token. There is no default
authorizer. The transport does not parse Clerk claims or infer identity from a
provider form. This callback remains an actual host integration requirement.

Opening exchanges the existing user token at Core's embed context route, resolves
the mount with a separately supplied server workload token, and resolves the
creator/encounter capture binding. Every provider operation repeats this sequence
and requires the original selection and binding. Fresh host authorization runs
before and after each request, including after credential acquisition. Core
continues to authorize every operation using its existing current-state rules.

Only the provider client's admission, operation and note paths are callable.
Workload and mount credentials stay request-local, including under concurrent
calls; only opaque client scope leaves an opened mount. Cookie storage, redirects
and environment proxy inheritance are disabled. Bounded JSON replies must match
the route version, nonce, binding, workspace, current timestamp and relevant
operation/session. Fixed errors disclose no credentials or protected bodies.

The transport never retries a mutation. The existing provider journal retains
the exact key and edit for an explicit retry or Core save resolution after an
uncertain reply. Revocation during a dispatched mutation hides its reply; it
does not claim to undo a server effect. Cancellation propagates to HTTP work.

This is a Tier 2 credential-boundary component prepared under the approved local
provider workflow work. It adds no route, runtime registration, dependency,
schema, identity provider, auth-policy change or activation. No existing Scribe
service authentication, desktop capture authority, Core/OS source or installed
native app changes. A real standalone host must bind the fresh authorizer,
reviewed Core origin/workload source and native request lifetime before use.

Qualification and recovery: keep the component disabled until that host binding
is concrete and reviewed within the applicable authorization. Local checks cover
identity change/revocation, request concurrency, bounded/correlated receipts,
cookie/credential separation, cancellation, and explicit lost-reply recovery.
The current TypeScript provider client also executes its actual configured
admission → review → note request sequence through this server code using offline
Core/identity fixtures. This is not real Core authentication or clinical-note
acceptance. No database or live service is touched. Recovery closes/disables this
transport and retains the provider's saved work; it changes no stored records.

Evidence: `/Users/jw/Desktop/Cosmas/scribe-provider-core-20260922.bRpB0BTG/`.
The seventeen focused checks pass with Node 24, along with Python types and affected
Python/JavaScript lint. The first concurrency fixture incorrectly assumed request
completion order; it now synchronizes both requests and compares by key. No
production transport fix was needed for that fixture assertion.
