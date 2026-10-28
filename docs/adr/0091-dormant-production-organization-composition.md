# ADR 0091: Explicit dormant production organization composition

Status: accepted for dormant source; production activation remains unapproved.

Use explicit sealed production build/runtime inputs to compose the existing Core
and strict organizational Clerk path. Keep the staging profile backward compatible
and the Apple beta application/container identifiers continuous. Neither renderer
configuration nor environment variables choose a new origin or identity profile.

Production requires configured audience, actual active organization, current
session ID and authorized-party binding. Default session tokens support additional
audience claims; named JWT templates omit session binding and are unsuitable.
The approved bounded-beta policy applies a deterministic patch only to the exact
pinned verifier and selects its missing-`azp` exception only from the production
compile/profile with an exact evidence-receipt binding. Present wrong/null `azp`
and every other issuer/audience/organization/session/subject failure remain
closed. This receipt is not authority or attestation. The stronger PKCE follow-up
is described in the [flight plan](../flight-plans/2026-10-28-production-native-organization.md).

The profile projector writes disabled unsigned inputs into a new directory. It
checks matching Box/workspace, key/issuer, Core origin, upload origin and explicit
helper digest declarations. Those declarations still require independent build
and deployment verification; they do not prove signing, policy approval or live
qualification. Production remains closed when inputs or installed acceptance are
missing. No Core user authority, consent, session, retention or custody policy is
changed by this composition.
