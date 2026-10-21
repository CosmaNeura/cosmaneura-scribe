# ADR0084: search-only Store fence ancestors

Status: proposed; Tier 2; signed runtime outcome unqualified.

Store111's fixed diagnostics establish component `openat` EPERM while preparing
the native filesystem coordinator. The specific component is unknown. The
walk requested directory read access for every ancestor even though those
descriptors only serve as relative lookup bases.

For Store XPC compilation only, both native fence copies request `O_SEARCH` on
root and nonfinal ancestors. Keep `O_NOFOLLOW` on every named component,
`O_CLOEXEC`, and the final private directory's existing read-only access. Root
with no components retains read-only access. All path, ownership, identity,
volume, lock, epoch, journal, fsync and cleanup checks remain unchanged.

This public mode requests less access; it grants no additional sandbox authority.
Reject symlinks and failures without fallback. Direct/non-Store access modes are
unchanged. No lock, journal or credential reset is part of this decision.

Primary basis: Apple's [public fcntl definitions](https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/bsd/sys/fcntl.h)
and [directory authorization implementation](https://github.com/apple-oss-distributions/xnu/blob/1031c584a5e37aff177559b9f69dbd3c8c3fd30a/bsd/vfs/vfs_subr.c).
Those sources retain sandbox/MAC authorization. They do not establish that
Store112 will pass the previously refused component or later metadata checks.

The [flight plan](../flight-plans/2026-10-21-store-directory-search.md) separates
source readiness from Root's later signed runtime qualification.
