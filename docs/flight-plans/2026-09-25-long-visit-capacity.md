# Align retained audio capacity for three-hour visits

Tier 2: encrypted audio processing, native recovery and additive constraint
expansion. Owner requested three-hour capacity, reuse and accelerated checks,
and authorized local checks/merge. This change does not deploy or activate a
cohort, start a microphone, retry terminal jobs or reset retained records/keys.

Canonical protocol 1.0 moves to 2,048 sequence positions and 384 MiB aggregate
plaintext allocation. Existing wire/encryption formats and legacy AAD are
unchanged. One retained mono/mixed track for three hours uses 1,080 ten-second
chunks and 353,894,400 reservation-budget bytes, leaving 48,758,784 bytes (148
additional reservations plus remainder). This is one retained track, not one
track per person. Multiple separately retained tracks share the aggregate cap.
The maximum assembled track stays below the existing Speech service's documented
500 MB / five-hour limits. No new processor or recording framework is added.

Reuse canonical generation, encrypted chunks, PR129's bounded reader, existing
uploader and worker heartbeat. Settings now default/cap assembly at the same
384 MiB value; a deliberately lower worker limit also reduces advertised and
enforced admission budgets. Keep the 900-second renewable lease, 90-reservation
batch, per-envelope limit, concurrency and creator/consent/source checks.

Receiver-first rollout: Core PR506 accepts old and larger receipts. Expand
Scribe database constraints with revision227fcc9bf18d before Scribe/API/worker
and native release activation. The migration replaces only four sequence CHECK
constraints in one transaction; old rows remain valid. Lock timeout5s and
statement timeout30s bound the attempt; any error rolls it back. Rehearse on
synthetic PostgreSQL, inspect existing constraints and resource budgets before
a separately authorized service deployment. Existing source-count/history
limits, row-level security, privileges and immutable triggers remain unchanged.

Client/native parsers accept later source starts and reopening; no automatic
three-hour recording claim. Continuous native renewal, background/screen-lock
capture, disk headroom, text capacity and short native hardware regression
remain required. Server resource sizing and actual Speech-service upload belong
to activation rehearsal; component tests use accelerated synthetic audio only.

Recovery: retain the expanded schema. Before larger data is admitted, revert
application code if necessary. After admission, keep compatible readers and
workers while disabling new long starts; never downgrade a reader that would
strand retained data. The migration intentionally refuses schema downgrade.
No recordings, keys, consent, source journals or failed terminal jobs are reset.
