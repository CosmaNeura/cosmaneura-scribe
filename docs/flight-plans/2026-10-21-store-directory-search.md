# Store directory search access

Tier 2; local source repair, inactive until independent review and signed qualification.

The signed Store111 auth service passed native parent/peer admission and reached
source custody setup. Positive diagnostics identified a component `openat`
failure with EPERM, followed by coordinator, recovery and owner failures. They
do not identify the component, so an ancestor refusal is not established.

Both Store fence walkers now request public `O_SEARCH` for root and nonfinal
ancestors. The last private directory keeps its existing read-only directory
descriptor. An empty-component root keeps read-only access as well. The same
component walk, no-symlink flags, dot/dotdot refusal, close-on-error behavior,
UID/mode/inode/link/volume checks, locks, anchor/epoch and fsync requirements
remain. Direct and non-Store compilation retains the original access modes.
There is no alternate path, entitlement change, permission retry or authority cache.

Apple's public Darwin implementation defines `O_SEARCH` as directory search
access and still enforces sandbox/MAC checks. Reducing requested ancestor access
may address the observed refusal; final-directory or later metadata refusal can
remain. Source checks cannot establish signed sandbox success.

Validation: focused existing offline fence/source checks, Swift syntax and
conditional-source equivalence, then independent exact-source review. Root
owns canonical builds, signing and one bounded synthetic startup. Keep existing
Store111 receipts and diagnostic source intact. Do not publish this local repair
or claim recording/auth success before actual qualification.

Recovery: retain Store111 and revert this source commit; do not remove lock,
epoch, journal, credential or container data. No data migration is involved.

See [ADR0084](../adr/0084-store-directory-search.md).
