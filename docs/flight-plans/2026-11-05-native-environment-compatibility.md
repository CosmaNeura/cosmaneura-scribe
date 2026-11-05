# Native staging environment compatibility

Tier 2: the client validates public runtime-profile metadata at an existing
native/session boundary. Owner: John. This is a client correction for the
already configured synthetic staging demo; it does not activate a cohort,
change identity/session admission, or add a backend capability.

## Problem and contract

The staging Core receiver truthfully returns `environment: Staging`. The iOS
client inferred `Production` from the existing-patient/v2 capability shape,
so the fresh catalog failed before patient setup. The native application
configuration also omitted its existing staging identity profile.

Return `core-staging-personal-v1` only when the sealed native identity,
fixed Clerk frontend and `core-staging-https-v1` receiver agree. Preserve the
existing compiled production profile checks. Native startup requires an
explicit known profile and its exact Core origin; the backend captures that
profile before connecting and requires the catalog/account environment to
match. Unknown and cross-environment profiles fail closed. The legacy desktop
capability contract remains unchanged.

## Existing visit path

The selected staging receiver and Core already negotiate
`native_visit_actions_v2`; the client still requires creation and the
existing-patient capability alongside v2. Full v2 exposes the existing
name-only walk-in form. Its submission retains the creation key and sends
`kind: new`, a synthetic name, null birth date and provisional identity through
the existing native encounters transport. The receiver requests Core's v2
capability and uses its existing authorized writer. No Core/receiver source,
release flags, tenant identifiers, consent gates or credentials change here.
The create-only help text is generic.

## Qualification and recovery

Run focused staging/production catalog, unknown/cross-environment profile,
startup, setup and desktop compatibility tests, capture types, changed-file
lint and provider packaging. Qualify the new renderer and native Swift change
in a separate iOS 1.0(97) source/archive packet. Local tests do not assert live
server or physical-device success. John controls any upload and distribution;
recording begins only after the fresh synthetic dry run succeeds.

Recovery: revert this client commit on a reviewed branch and issue a subsequent
iOS build. This leaves backend flags, data and access state intact; returning
to build 96 also returns its known staging catalog rejection. Production is
outside this release decision. No migration or schema rollback applies.
