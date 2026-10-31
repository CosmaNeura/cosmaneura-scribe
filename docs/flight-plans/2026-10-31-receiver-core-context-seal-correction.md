# Receiver Core-context image seal correction — Tier 2

Merged consumer d4c4679 packages `core_context_receiver.py`, but the image launcher
still requires the earlier five-file source set. A newly built sealed image would
therefore reject its own six-file manifest before configuration materialization.
Add the already-reviewed consumer file to the launcher's exact required source
set and compare preparer and launcher contracts in the existing context test.
No receiver behavior, authority, identity, configuration, resource, dependency or
activation flag changes. The SHA-256 check still covers every required source.

The offline image context checks cover configuration materialization, identity
tamper refusal, disabled startup and the producer/consumer source-set seam. No
production credentials, image publication or runtime activation occurs. Review
the final source independently before publication. The older published/held
five-file artifact is not covered by this source and must not be relabeled.
Before deployment, discard this correction. After separately approved deployment,
disable the receiver and restore the qualified prior artifact/configuration pair;
retain recovery IDs, recordings, keys, schema and audit data.
