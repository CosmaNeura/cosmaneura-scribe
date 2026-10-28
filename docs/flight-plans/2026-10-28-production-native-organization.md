# Production organization profile: dormant composition and native policy decision

Risk: Tier 2 (identity, environment and deployment boundaries). This change is
source preparation for founder review. It does not deploy, create credentials,
enroll a practice, enable a cohort, release an app, or qualify production.

The existing schema-1 receiver and packaged staging clients keep their staging
origin, personal-session policy and disabled defaults. The new production
composition uses Core `https://app.cosmaneura.com`, Clerk
`https://clerk.cosmaneura.com`, an explicit receiver origin and strict configured
organization/audience/session checks. There is no production fallback to staging.
The existing Apple application identifier remains `com.cosmaneura.scribe.beta`;
the direct and Store Desktop auth identifiers retain their separate containers.

## Evidence and actual blocker

Clerk's [JWT-template documentation](https://clerk.com/docs/guides/sessions/jwt-templates)
says template tokens are not session-bound and cannot carry `sid`. The clients
therefore retain the SDK's default session-token request with `skipCache: true`.
Clerk supports [custom claims on default session tokens](https://clerk.com/docs/guides/sessions/customize-session-tokens),
which can supply the configured audience while retaining the real session ID.
No `sid`, organization, clinical role or native-origin claim is fabricated.

Clerk's [session-token reference](https://clerk.com/docs/guides/sessions/session-tokens)
describes `azp` as the original Frontend API Origin and says it can be omitted.
Its [Frontend API errors](https://clerk.com/docs/guides/development/errors/frontend-api)
require native Authorization and prohibit combining it with Origin. The current
SDK middleware follows that native rule. Customizing audience does not solve
missing native `azp`, and a named template does not solve session binding.

The pinned `cosmas_os` verifier already permits an explicitly isolated Apple
session without `azp`, retaining signature/issuer/audience/organization/session
checks. Its Desktop exception is limited to the staging personal profile. The
new production runtime deliberately selects **neither exception**. Native tokens
without `azp` will fail until the separate security decision below is resolved.

## Reviewable native policy alternative — not applied

`docs/production/production-native-organization-policy.patch` is a dark candidate
against pinned external `cosmas_os/api/auth.py` SHA-256
`7eac6550c8723f80e558f61c34b6c74b3017e2d8f795344eb5ccd62d1c3fae7d`.
The production dependency and runtime do not apply or select this patch.

The candidate adds a separate explicit production native-organization selector.
It accepts missing `azp` only for a deployment-selected singleton Apple or Desktop
origin, production Clerk issuer/JWKS, authorized-beta data mode, no synthetic
seeding, a configured audience and real organization, and an explicit reviewed
policy receipt. A present incorrect/null `azp` still fails. Existing RS256,
freshness, `sid`, subject and audience/organization verification stay unchanged.
The default verifier and all staging behavior stay unchanged.

This is a security-policy choice: native session credentials and the configured
audience identify the signed-in user/session and intended service, not a remotely
attested executable. The native Origin header is an allowed channel assertion,
not authority. A stolen bearer remains a bearer. Approving this alternative
requires reviewing the exact native credential custody, receiver ingress
isolation, Entra workload caller/roles, and fresh Core membership/session/consent
checks as one channel. A receipt string alone grants nothing and proves nothing.
Core's existing native facade rechecks its Clerk session plus both workload
policies; this candidate changes no Core authority or practice attestations.

The stronger alternative is a Core-issued, single-use, short-lived PKCE handoff
bound to an actual browser-authenticated session, organization, audience, native
client and purpose. It needs a new credential protocol, callback replay store and
receiver admission contract; it is not implemented by this PR and cannot be
represented as an immediate configuration change.

## Founder inputs and rollout sequence

1. Confirm the actual production Clerk publishable key, organization and audience,
   default-session custom-claims configuration, native API/app callback settings,
   and chosen native policy. Do not alter existing custom claims until their
   production consumers have been reviewed. Record evidence by hash without
   tokens/passwords/user records in source or logs.
2. Supply an owned production receiver origin, environment/Box/workspace UUIDs,
   read-only registry database/role, managed-identity client ID/Core scope, exact
   Azure ciphertext upload origin and reviewed ingress/isolation deployment.
   Supply the separately reviewed protected-data deployment receipt covering
   the existing clinic/BAA/PHI and retention/custody authority. No such receipt is
   produced by this source. A hash is only a binding to reviewed evidence.
   The receiver registry already has supported Core account/encounter mappings;
   these are not generated from configuration or client data.

   The adapter uses `Settings.workspace_authentication_errors()` solely as an
   identity projection. It does not launch the full OS application, whose
   `early_adopter_beta` startup gate has additional storage/legal/workspace
   requirements. The adapter's data-mode and local-origin fields do not grant
   protected-data permission or declare those general OS gates satisfied. The
   separate adapter deployment review and current Core authority are required.
3. Independently review the final Scribe source. Merge dormant composition only.
   If approving the native policy alternative, independently review and merge it
   in its owning identity repository, pin its exact new digest, add an explicit
   receiver/client activation contract, and re-review that activation separately.
4. Build clients with `SCRIBE_PRODUCTION_ORGANIZATION` in an owned output and
   exact sealed Info/package inputs. Lab-network builds cannot use production
   transport. Desktop's offline builder has an explicit
   `--production-organization` flag; the same Swift definition must reach both
   iOS plugin/library targets. Re-sign; copying new settings into old signed
   staging artifacts is not a production build.
5. Founder deployment remains separate. Verify installed source/image digests,
   the authorized production cohort and actual session claims, then perform
   recording/Finish/Save/reopen/Listen/dashboard and selected Zoom qualification.
   Missing bindings, policy approval or a failed gate means production remains
   unqualified. No stage result substitutes for that installed acceptance.

## Recovery and validation

Before activation, recovery is to discard the dormant output or revert this
source change; staging resource configuration, data and builds are untouched.
After a separately approved activation, disable the production profile before
rollback and retain original queue/custody data. Do not erase pending recordings
or switch their environment. Desktop encrypted creation records use the supplied
production workspace UUID and reject the existing staging namespace.

Focused checks cover unchanged staging composition, missing/mixed production
bindings, exact edge authority, isolated Desktop namespaces, compile gating and
strict client claim rejection. Candidate-policy JWT tests must use offline keys
and a copied pinned source only. Full model/UI matrices are outside this change.
