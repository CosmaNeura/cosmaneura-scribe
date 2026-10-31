# ADR 0096: Explicit dormant production personal-session compatibility

Status: accepted for dormant source; production qualification remains open.

Existing Core accounts can authenticate with a personal Clerk default session
without an active Clerk organization. Requiring one fixed organization and an
invented session audience in every Scribe production client would prevent those
users from connecting. Add the explicit `core-production-personal-v1` production
profile alongside the existing strict organization and staging profiles.

This profile uses the existing production Clerk instance, publishable key and
Core origin. It preserves the original Clerk subject and session, local identity
tuple, logout fence and native request transport. It expects no organization and
binds the actual observed default-session audience: a configured audience must
match; a genuinely absent audience requires the token's `aud` claim to be absent.
The separate Entra workload scope is never substituted for a Clerk audience.
Default session tokens remain required; named JWT templates cannot replace the
session binding. Native authorized-party validation and the bounded,
receipt-gated missing-origin exception remain unchanged.

Personal mode is supported only by `core-provider-context-v1`. The receiver
constructs no registry database engine and obtains provider/practice and record
authority afresh from Core. A valid personal session is not practice enrollment,
an agreement, a billing exemption, consent or access to any patient or saved
record. This change alters no Core user, provider, patient, appointment or note,
and grants no grandfathering by itself. Existing-account correspondence and
Core admission must qualify before activation.

The optional infrastructure profile retains organization mode as its default.
Personal mode must be selected explicitly and projects only Core authority with
null registry database fields. Client and receiver activation remain independent
and default off. All four production evidence bindings, immutable source and
image inventories, helper digests and actual production compile receipts remain
required. The historical compile definition `SCRIBE_PRODUCTION_ORGANIZATION`
continues to gate both production profiles; a profile string cannot enable it.

The maintained verifier patch applies only to the exact qualified OS source in
the Scribe-owned receiver composition. Global OS and Core authentication remain
unchanged. New patch bytes require a new receiver/image seal, and changed Swift
requires fresh full native compilation and signed-package verification. Existing
receipts cannot be relabeled. See the [flight plan](../flight-plans/2026-10-31-production-personal-session.md)
for the held operational gates and recovery boundary.
