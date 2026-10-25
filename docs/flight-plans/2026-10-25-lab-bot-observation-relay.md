# Synthetic lab bot observation relay

Tier 2: this adds a scoped credential-bearing transport inside the owned lab.
Owner: John Willems. Initial cohort: the two authorized synthetic lab profiles
and the owned Dublin Mac only. Expires November 1, 2026 UTC. No production,
provider credential transfer, general API proxy, or database change is included.

The existing collector stays on the authenticated controller. A per-run relay
listens only on an ephemeral `127.0.0.1` port. Its random capability and endpoint
must be saved mode 0600 and transferred only into the owned remote run directory.
A separately reviewed, host-pinned SSH reverse forward binds only remote
`127.0.0.1`. This module does not create tunnels or select remote hosts.

Only `observe` and `observeStopped` with the exact run and a fresh nonce reach
the collector. The complete existing BotCaptureProofGate validates the metadata
before transmission. Consent, host End evidence, discovery, credentials and
provider mutations remain outside this interface. The source measures the whole
remote request using its own clock and revalidates the unmodified DTO. The
two-second admission budget and source watchdog remain unchanged. A failed
recording read blocks restart; explicit stop reconciliation remains possible.

Validation includes real local sockets with synthetic contract DTOs, invalid
capabilities/scope/extra fields, nonce replay, concurrent and late requests,
credential-bearing output refusal, abort/cleanup, and stop after observation
failure. These tests do not qualify remote latency, recording, or saved output.
Live acceptance additionally requires a verified owned tunnel, actual collector
and local native Zoom custody, whole-request latency within two seconds, and
actual recording/end/persistence evidence. Unknown state is a failure.

Recovery: stop the owned source first, close the relay/client and owned tunnel,
and independently close/reconcile the collector. Retain uncertain capture state
and all failed receipts. Revert these lab files if necessary. No whole-service
rollback, recording retry, database operation, or security-setting change is
part of recovery. Review final pushed code independently before live use.
