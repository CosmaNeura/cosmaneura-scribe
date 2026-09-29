# Reduce the scheduled capture-processing wait

Tier 1. The owner requested faster recording-to-transcript operation for the MCD
beta. The September29 synthetic Mac capture finalized at11:40:40.817UTC; its
speech job was claimed at11:41:20.167 and completed at11:41:25.404. The current
speech and translation jobs each run `--pending` once per minute. One discovery
pass followed by immediate exit leaves later uploads waiting for another start.

Reuse each job's existing initialized clients for a65-second pickup window,
checking every5seconds. Keep the configured total target budget per execution
(currently8); each discovered session is attempted at most once in that
execution, even if processing fails. Explicit session-ID runs remain one-shot.
The pickup deadline uses monotonic time and does not cancel already accepted
processing. Cancellation still closes all worker resources.

Scheduled executions can overlap. Existing tenant-scoped discovery, live
consent checks, durable claims, lease heartbeats and three-attempt maximum remain
authoritative. No new audio/transcript path, queue, credentials, network access,
settings or storage format is introduced. No completed or terminal recording is
replayed. This change does not reset a job or grant an extra diagnostic attempt.

Operational tradeoff: otherwise-idle scheduled runs remain alive for up to65
seconds, increasing idle compute time. Current allocation remains0.5CPU/1GiB
per worker; schedule, replica retry limit0, timeout1800seconds, identities and
permissions stay unchanged. This is bounded polling for the existing beta
workers; event-triggered infrastructure is outside this change.

Validation includes a fresh local PostgreSQL rehearsal: the first discovery
sees no uploaded recording, the existing encrypted capture API completes an
invented recording between polls, and the real discovery/claim/assembly/worker
path publishes once on the next poll. Provider speech is substituted locally.
Also verify one-shot attempts, repeated failed targets, the total work cap,
deadline expiry, long accepted processing, cancellation and existing encrypted
speech/consent/lease/recovery cases. These checks do not claim new live latency.

Staging rollout: merge checked source, bind and verify an immutable image using
the current worker image as the retained base, reconcile current configuration,
then update speech and translation job images only. Preserve running executions;
observe future scheduled execution success and unchanged workload settings.
Leave API, receiver, Core, native apps and production unchanged. Recovery is an
image-only return to the prior worker digest; retain all database state and keys.
