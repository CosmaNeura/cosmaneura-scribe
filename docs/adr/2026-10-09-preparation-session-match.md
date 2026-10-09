# Match opaque preparation to a verified session across token refresh

The native driver deliberately obtains a fresh Clerk JWT for each request. A full
token digest consequently cannot identify a stable authenticated session. Use a
private fixed digest of issuer/subject/sid returned by the existing actual verifier
in the exact personal staging profile, together with the existing account,
recovery, actor, tenant, revision, visit, binding and next-step keys. Derivation
does not accept unverified decoding or caller-supplied claims. Original per-call
and ordinary capture authorization, consent and thirty-second expiry still run.
Callers without this verified fingerprint retain exact-token matching.

This changes credential correlation only; no token/access cache, native token
refresh change, workload-policy change or source-start shortcut is introduced.
