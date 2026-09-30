# Creator continuation receiver and native adoption

Tier 2. The owner explicitly approved parallel implementation and testing of
recording-start performance improvements on September 30. The change composes
existing creator-authorized renewal and reservation operations, retaining their
consent, retention, tenant, key and lease checks. It creates no new identity,
cohort, dependency, media format or database structure.

## Receiver-first sequence

1. Validate the Scribe receiver against a fresh disposable PostgreSQL database.
   Test exact/concurrent/restarted replay, ordinary component receipt recovery,
   both supported channels, depleted budget, canonical-position reuse,
   unauthorized callers, revoked consent, expired retention and completed
   sessions. Failed reservation or renewal must roll back all new claims.
2. Land Scribe's additive continuation route and generated wire contracts.
3. Land Core `prepare_continuation_window` forwarding with the exact ordinary
   component-key derivation and closed request/receipt validation. Retain
   ordinary operations for existing native pending intents.
4. Adopt new intents in desktop and iPhone only after both receivers are
   available. Freeze outer and component keys in the existing encrypted native
   journal before dispatch. Validate reply-loss recovery, receipt adoption and
   simulated latency. Recheck the installed release on real devices when they
   are idle and available; do not claim synthetic timing as physical acceptance.

## Recovery

Keep the additive route and durable ordinary receipts. Revert the consumer
selection for newly created intents while allowing existing combined intents
to recover. Do not clear pending state or mutate retry keys. No migration rung
or data rollback is required. Production promotion remains outside this plan.

## Evidence

`tests/test_creator_continuation_routes.py` exercises atomicity and receiver
recovery with synthetic metadata and no microphone, upload or speech provider.
`tests/test_creator_recording_routes.py` preserves ordinary route authorization
and receipt behavior. `tests/test_canonicalization.py` pins component request
fingerprints. Record final tested commit, commands and results in the PR;
uncommitted local evidence is a checkpoint, not deployed-state proof.
