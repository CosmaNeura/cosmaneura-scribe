# Reuse Core connections across native provider requests

Tier 2: shared transport under the existing provider authentication boundary.
The owner prioritizes opening and record-readiness latency and permits staging
deployment of passing critical-path fixes.

Each incoming receiver request currently creates and closes its own HTTPX
transport. Repeated Core requests pay repeated TCP/TLS setup even while the
same provider opens an encounter or starts recording. Reuse HTTPX's bounded
connection pool for the receiver lifetime: eight total connections, four idle
connections retained up to thirty seconds, zero transport retries. Existing
per-request timeouts and redirect restrictions remain.

Only sockets are shared. Each operation retains its own client and no-cookie
policy; native user credentials, workload credentials, mount negotiation,
fresh registry reads and pre/post-I/O authority checks remain request-local.
The pool is fixed to one HTTPS origin and event loop. Closing an operation
retires its borrowed transport. Runtime shutdown or startup failure closes the
owned pool alongside existing verifier, database and credential resources.

Validate actual local certificate-verified TLS connections: three successive
separate clients previously need three connections; borrowed transports need
one while request credentials stay distinct. Exercise close/reuse, revocation,
wrong origin/loop, lost response without retry, and existing Core wire checks.
Run lint/types and receiver build/source verification before staging activation.
This connection reduction is not an end-to-end latency or 50% improvement claim.

Release is receiver-only from a merged commit, with current Core, API, speech,
translation, schemas and identity/configuration retained. Verify readiness and
the exact image/configuration after activation. Recovery is the previously
verified receiver image; there is no migration, data write or device update.
