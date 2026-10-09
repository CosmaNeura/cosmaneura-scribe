# PyJWT authentication update qualification

Prepare the Scribe operator to review and release PyJWT 2.15.0 without relaxing
workflow authentication. This is Tier 2 because it changes the dependency that
verifies service tokens. The user authorized local auth qualification on October
4, 2026; that authorization does not deploy, activate a cohort, or change identity
configuration. Staging login and native acceptance are deferred until tester
access and a supported Mac build are available.

## Scope and security changes

Apply the lock-only patch from Dependabot PR 260 to current main
`dd6f5ffd309a99c81c0d06a5391ff7b0b82f9d1b`, retain its later provider-trace changes,
and raise the declared PyJWT floor to 2.15. Add focused tests; leave production
authentication code, RS256 allow-list, issuer, audience, tenant, client, app-only
role requirements, consent, storage, routes, and environment configuration intact.

The [upstream changelog](https://github.com/jpadilla/pyjwt/blob/2.15.0/CHANGELOG.rst)
documents normalized malformed-claim and recursion errors, parsed JWKS caching,
malformed-key handling, and network-error normalization in 2.15.0. Version 2.14
also hardens key handling, redirects, and unknown-key refresh throttling. The
new tests exercise the Scribe boundary with real RSA signatures and PyJWKClient;
only JWKS HTTP I/O is replaced with fictional in-memory responses. They do not
verify live Entra keys, network redirects, or native authentication.

Availability changes during key rotation: the new SDK starts a 30-second
unknown-key refresh cooldown after a successful JWKS fetch. A newly published
key can therefore receive Scribe's existing sanitized 503 until the cooldown
expires; known cached keys continue to work. Qualification checks recovery after
that interval without disabling throttling. The existing per-key LRU has no
time-based expiry; this update does not add a key-revocation guarantee.

## Qualification and release gates

- Verify a valid signed request succeeds, while missing/lifetime/invalid
  signature/algorithm claims fail closed with sanitized responses and logs.
- Verify deeply nested payloads return 401, malformed JWKS entries do not break
  valid keys, unknown key IDs cannot force repeated fetches within the cooldown,
  rotation recovers after that cooldown, and truncated JWKS responses return 503.
- Run the existing authentication, consent, capture, handoff, and repository
  suites plus scoped lint, types, lock consistency, and change-budget checks.
  Keep any baseline failures explicitly distinct from passes.
- Obtain independent review of the final pushed SHA. Keep Actions disabled;
  local evidence is not hosted CI or a deployment authorization.
- Before release, use the approved operator process with merged source and a
  recorded predecessor image/digest/configuration. Reconcile deployed drift and
  other dependency PRs; rerun qualification on the actual integrated candidate.
- In synthetic staging, verify a genuine Entra app-only request succeeds and a
  wrong client/role/tenant/expired token is refused. Record metadata-only
  evidence. Never retain bearer tokens or real patient data. Native acceptance
  and Stripe billing remain separate gates.

## Recovery and limits

No schema or data migration applies. Do not disable authentication or add a
fallback if valid callers fail. Pause the affected staging workflow and inspect
sanitized diagnostics. An authorized operator may restore the recorded
predecessor image without altering stored rows, identity configuration, or
consent. That predecessor contains known PyJWT security issues; a temporary
return requires explicit risk acceptance and must not introduce PHI or widen
the cohort. Prefer a reviewed forward fix.

Keep PR 260 open until maintainers choose this current-main qualified replacement
or retain the original dependency PR with separately integrated tests. Do not
merge both as separate deployment outcomes or treat qualification as approval.
