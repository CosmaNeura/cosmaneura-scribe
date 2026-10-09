# Same-request native server timing

Tier 1. Owner-approved synthetic performance work; no authentication, consent,
recording custody, clinical content, schema or environment policy change.

## Problem and outcome

Mac43 with Receiver29/Core29 still took 18.826 seconds for the three opening
requests in one measured run. Two bounded Azure tail collectors retained no
usable phase events. Empty tails do not establish zero duration or a disabled
logger. This change carries the existing content-free request timing snapshot
in a fixed `Server-Timing` response header and records the validated values in
the same native request event as token, receiver and total duration.

## Contract and boundaries

The header contains exactly eight `scribe_` metrics: registry, workload_token,
core_exchange, core_mount, core_binding, core_operation, core_encounter_lookup,
and total. Values are finite nonnegative milliseconds, bounded to one hour,
with three decimal places. Unmeasured phases are zero. The request context is
closed before snapshotting; late tasks cannot change its values. Formatting
adds no I/O or database work. Any preexisting Server-Timing header is replaced.

These are receiver-side intervals, not eight independent additive durations.
In the new Core facade, internal exchange, mount, binding and lookup work is
inside the receiver's `core_operation` interval; zero in those separate phase
fields means unmeasured separately, not free or skipped authorization. `total`
is the enclosing request duration and can include work outside named phases.

The native transport extracts only this header from the already validated
fixed-origin HTTP response. The parser rejects extra/missing metrics, duplicate
fields or names, unknown names, arbitrary parameters/text, malformed/nonfinite
or oversized durations, and oversized header values. Foundation may coalesce
multiple header lines; repeated complete metric sets are rejected after that
coalescing. Invalid or absent diagnostics are omitted while the original
response handling and authorization checks continue unchanged. Parsed values
are immutable and travel with one reply; no response cache or credential cache
is introduced. No identifiers, payloads, URLs, credentials or error text enter
the timing log. No timing value authorizes capture.

## Validation

Run provider timing unit tests, the actual receiver registry suite, the existing
native transport and provider qualification harnesses, assembly parity checks,
Python lint/types, and the PHI-log policy. Tests cover concurrent request
isolation, late task closure, exact phase values, rejection of malformed header
metadata, replacement of an untrusted response header, and actual URLProtocol
header propagation without affecting status/body. Existing native cancellation,
revocation, key-custody and source-start checks remain in their harnesses.

## Delivery and recovery

Start from merged ca7e9d9093d91260101c70d6ef3a725292df5a73. Deliver a receiver-only
image on qualified Receiver29/Core29 and include the mirrored native files in
the next Mac build. Keep Core29, API14, workers, identities, configuration and
schemas unchanged. The signed iPhone57 artifact is unchanged by this work.
Either rollout order remains compatible: older clients ignore the header; newer
clients accept older receivers without diagnostics. Recover by restoring the
previous receiver image or native artifact; there is no data migration.

## Acceptance still required

After deployment, collect a bounded native timing sample on the retained
synthetic encounter. Compare registry/token/Core time in the same response and
then target the demonstrated bottleneck. Local validation and this diagnostic
change do not establish faster recording or satisfy the four-second goal.
