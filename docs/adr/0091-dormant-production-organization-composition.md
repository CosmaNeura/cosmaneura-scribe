# ADR 0091: Explicit dormant production organization composition

Status: proposed; production policy and activation unapproved.

Use explicit sealed production build/runtime inputs to compose the existing Core
and strict organizational Clerk path. Keep the staging profile backward compatible
and the Apple beta application/container identifiers continuous. Neither renderer
configuration nor environment variables choose a new origin or identity profile.

Production requires configured audience, actual active organization, current
session ID and authorized-party binding. Default session tokens support additional
audience claims; named JWT templates omit session binding and are unsuitable.
The pinned verifier and current runtime remain strict. The missing native `azp`
issue requires an explicit security decision, not fabricated claims or a hidden
exception. An unapplied external native-policy candidate and the stronger PKCE
alternative are described in the [flight plan](../flight-plans/2026-10-28-production-native-organization.md).

The profile projector writes disabled unsigned inputs into a new directory. It
checks matching Box/workspace, key/issuer, Core origin, upload origin and explicit
helper digest declarations. Those declarations still require independent build
and deployment verification; they do not prove signing, policy approval or live
qualification. Production remains closed when inputs or installed acceptance are
missing. No Core user authority, consent, session, retention or custody policy is
changed by this composition.
