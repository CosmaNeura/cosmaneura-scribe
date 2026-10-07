# urllib3 security qualification

Update only the locked urllib3 transport dependency from 2.7.0 to 2.8.0 on the
current default branch. This Tier 1 dependency change addresses Scribe alerts
41–43. Keep application identity, consent, storage and environment settings
unchanged. The existing urllib3 update PR is #261; do not merge duplicate updates.

The upstream fixes bound chunk-size lines, terminate Deflate streams with trailing
bytes and preserve proxy-specific TLS policy. Qualify all three with network-free
regressions, including a subprocess deadline for the former infinite loop.
Compare package inventories to confirm no unrelated dependency changes. Run the
full Python suite with a fresh owned synthetic PostgreSQL database, whole Ruff,
formatting and Pyright. See the
[upstream release notes](https://github.com/urllib3/urllib3/releases/tag/2.8.0).

Recovery is reverting the lockfile and qualification commit before promotion;
the previous dependency remains vulnerable and is not a security acceptance.
No migration, deployment, cohort activation or live credentials are required.
Independent final-head review and local receipts must accompany the PR. Local
results do not prove deployed staging payments or native-device acceptance.
