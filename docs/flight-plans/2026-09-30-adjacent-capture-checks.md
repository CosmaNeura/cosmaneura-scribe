# Adjacent capture request checks

Tier 2. The owner authorized Scribe performance implementation, local checks,
review and staging delivery; production is excluded. This change extends the
existing opening-request boundary sharing to one capture request at a time.

The receiver checks current selection before dispatch and before publication.
Within the transport's exchange -> mount -> operation sequence, use each
post-I/O current check as the immediate next pre-I/O check only when no await
intervenes. Acquire the workload credential before the first shared check. Keep
that credential and the single-use check object request-local; clear them when
the operation finishes. Keep the source-ready cancellation yield and receiver's
final fresh selection check. Do not change operation keys, payloads, consent,
source custody, token freshness, or checks across I/O.

For a Core-created visit this removes two redundant encounter lookups: one
capture operation changes from eight lookups plus three control requests to six
lookups plus three control requests. This is a source/fixture count, not a claim
of measured staging or device latency. The iPhone's 24s opening, 7.6s start and
168s finish observations still need phase measurements; zero matching native log
events cannot establish a fast phase. Opening, note and admission semantics stay
unchanged. No public contract or database migration is needed.

Validate actual transport ordering, denied/switched accounts after every I/O,
workload-token suspension and cancellation, one-use lifetime, concurrent source
requests, exact replay and uncertain replies. The real receiver tests use a new
empty database in the existing socket-only synthetic fixture, with current
registry rows and a mocked Core wire. Count all six lookup boundaries and deny
publication if revocation occurs during the final lookup after a remote effect.
Keep the existing negative route/identity and malformed-response tests.

After parent review and passing local checks, build a receiver from the merged
source and reconcile its fixed staging configuration before image-only delivery.
No native rebuild, schema migration or stored-data mutation is required. Recovery
is the previous immutable receiver image; retain every original request, queue,
key, note and source. Physical validation needs current quiet-room confirmation
and explicit controlled synthetic actions, with microphone readiness distinct
from spinner/timer feedback.
