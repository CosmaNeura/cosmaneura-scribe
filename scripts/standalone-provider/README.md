# Standalone provider receiver preparation

This is the native/server connection for the existing provider entry, prepared
separately from W13. `ProviderReceiver(...).app()` supplies a real FastAPI app.
It is disabled by default, starts no listener and is not registered in the Scribe
production API. No real Core origin, workload credential, account correspondence,
standalone native endpoint or release has been configured by this increment.

`prepare_sources.py` copies twelve unchanged, hash-verified identity/model files
from the qualified W13 build-4 receiver into a new owned source directory. It
copies no runtime configuration, credentials, database or TLS material. The
receiver imports this frozen package and the current Scribe Core transport. It
does not import Core's application/startup or edit the OS/Core checkouts.

The host must supply an explicit `ReceiverProfile`, existing owned SQLAlchemy
engine, fully configured retained `Settings`, retained `ClerkTokenVerifier` and
server workload-token provider. The already qualified native session option on
that verifier remains explicit. No claims are parsed in this receiver. Every
operation reuses `authenticate_request`, active human/external identity checks,
creator-owned workspace and confirmed encounter checks, and a non-revoked,
reviewed `CoreCaptureAccount`. Core then independently authorizes the current
user token, mount, creator, tenant, encounter and capture binding.

The fixed native interface accepts HTTPS POST only, an exact configured Host and
native Origin, a native-held bearer and `X-Scribe-Native-Revision`. That revision
is a cancellation epoch, not identity or authorization. Mounts and clinical
operations also require an `Idempotency-Key`; clinical keys are forwarded intact.
No cookies, browser preflight, forwarding/authority headers, arbitrary URLs,
mutation retries or credential-bearing responses are supported. Replies are
bounded JSON with `Cache-Control: no-store` and fixed failure codes.

| Path under `/provider/v1/` | Body and behavior |
| --- | --- |
| `catalog` | `{}`; returns the current creator's provisioned Core encounter/workspace observations. Core permission is resolved again when opened. |
| `mount` | `workspace_id`; negotiates actual Core authority, returning the scope, display row and stable recovery UUID required by the provider host. |
| `recorder` | `workspace_id`, `binding_ref`, `session_id`, `request_nonce`; confirms that Core's current capabilities belong to the requested admitted session. Starts no recording. |
| `capture-admissions` | The existing `CoreCaptureClient` envelope, including configured language and all-party consent. |
| `capture-operations` | The existing envelope for capture/upload, creator review and translation decisions. |
| `capture-notes` | The existing Core SOAP read/templates/prepare/save/resolve envelope. |

The catalog intentionally requires provisioned Core observations and creator
workspaces. This component does not create appointments, import encounters,
create OS workspaces, grant Core access, upload ciphertext or open Core UI.
The native binding must still connect this interface, its existing upload
target, Core encounter creation/navigation and native request cancellation to
`createProviderIOSHost`. Desktop composition remains separate.

Recovery scope derives from the explicit environment UUID, verified box/creator
and reviewed Core account row. Native restarts retain that scope; a different
account/environment/creator cannot silently reopen prior retained work. Each
authorization opens a new database session so committed revocations cannot hide
behind an ORM cache or transaction. A revoked reply is suppressed; a mutation
already dispatched to Core is not represented as undone. Remote IdP revocation
latency remains that of the existing verifier and Core, pending native acceptance.

The local checks use a new socket-only PostgreSQL cluster and the seven actual
retained tables. `test_receiver.py` refuses a nonempty test schema, checks the
data directory and disabled TCP listener, and verifies all frozen source hashes.
Each rerun uses another empty database; it never reseeds an existing trial.
An offline RSA key exercises the real verifier, while Core responses are explicit
wire fixtures. The actual TypeScript `CoreCaptureClient` drives its admission,
review and note sequence through the ASGI app. No device, real sign-in, model,
Speech/translation service or real Core mutation is exercised by these checks.

See [ADR 0051](../../docs/adr/0051-standalone-provider-receiver.md) for activation
boundaries and the current evidence directory.
