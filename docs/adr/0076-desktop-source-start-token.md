# Carry the original desktop admission token through one source start

Status: accepted within the owner's October 14, 2026 bounded authorization.

The native desktop admission already transfers its fresh token to one clean
initial-window request. The following source-start-ready request still forces
another SDK mint. Recording startup is above the five-second target; coarse
Azure metrics do not show CPU saturation during the latest measured start.

Extend the existing native handoff to one matching source-start-ready request
after successful outer window publication. Require the complete mixed window
receipt: matching session/key, generation one, thirty consecutive reservations,
consistent AAD, original lease and capture deadline. Retain admission consent,
account, identity, mount, epoch and the original immutable expiry/clocks.

The source owner destructively claims the handoff before awaiting. Recheck
currentness and token validity immediately before I/O; use fresh authentication
once for an ineligible or expired handoff before dispatch. Preserve in-flight
publication fences and the source owner's full decision validation and original
stop journal. Both returned source decisions must match admission consent when
the token was reused. No uncertain request is retried automatically.

This is native RAM custody with a closed caller and a single matching request,
not global caching. It preserves Core's authentication/access/consent checks
and existing source authority. Legacy or incomplete windows decline the
handoff and retain fresh authentication. A Clerk-only remote revocation after
admission no longer forces another SDK mint for this matching SOURCE during the
original interval; the synthetic fixture explicitly exercises this bounded
bearer-token residual. Core's current access/consent checks still apply.

The shared connection copy remains synchronized for existing source assembly;
the phone's desktop opt-in remains disabled and its source owner is unchanged.
No phone package, backend, dependency, storage, renderer contract or token-policy
change is included. Removing a mint is testable virtually; physical startup
improvement remains to be measured.
