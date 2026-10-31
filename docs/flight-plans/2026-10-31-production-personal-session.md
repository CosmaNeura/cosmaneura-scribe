# Production personal-session compatibility flight plan

## Problem and boundary

The existing production platform accepts personal Clerk default sessions for
legacy accounts. Scribe's original production organization profile requires an
active fixed organization and configured audience. The explicit dormant
`core-production-personal-v1` profile supports the existing login identity
without moving users or records. Cosmas MD testing and MyCatholic Doctor's
operational cohort still require actual Core practice/provider correspondence;
owner-held agreements and external invoicing are Core operational decisions.

This source change does not enroll accounts, migrate clinical records, set
agreement/billing flags, change Core login policy, provision resources, activate
production, notify testers or publish clients. No production readiness is implied
by fixture results or receipt-shaped values.

## Source and protocol behavior

The sealed native profile uses production `pk_live_`, issuer
`https://clerk.cosmaneura.com`, Core `https://app.cosmaneura.com`, the existing
iPhone and Desktop identifiers, the original subject/session and the existing
logout/access fence. The wire profile is `core-production-personal-https-v1`.
The production compile flag remains `SCRIBE_PRODUCTION_ORGANIZATION` and is
mandatory for both production profiles. The native bridge matches the fixed
auth, application and receiver profiles before permitting production transport.

The personal profile requires nil organization. Its audience is an explicit
projection of the actual default session: if absent, any `aud` claim is refused;
if present, that exact configured audience must match. Subject/session, signature,
issuer, expiration and native authorized-party checks remain mandatory. Wrong or
null native party is refused. Missing native party remains available only under
the existing bounded production native-policy receipt.

The receiver requires Core authority and null registry database fields. Every
provider/catalog/record operation continues to obtain fresh Core authorization
and use the original Core references. Organization and staging profiles retain
their separate validation and defaults. Generic OS authentication is unchanged.

## Acceptance gates

1. Independent Tier 2 review of the complete native/bridge/receiver/projector
   and pinned-verifier patch. Local regressions must prove both native origins,
   audience presence/absence, wrong issuer/session/party/organization rejection,
   unchanged organization/staging guards, no registry connection in personal
   mode, default-off projections and all existing receipt/helper/compile guards.
2. Actual production native default-session observation using the existing
   accounts and SDK. Record only bounded sanitized claim facts and provenance,
   never the JWT or credential. Bind the real audience policy and native-origin
   behavior to new actual session/policy receipts. No fabricated claims or
   fixture identity may satisfy this gate.
3. Core existing-user correspondence and admission qualification. Confirm the
   same Clerk/Doctor identities, valid authorized practice membership and access
   to their existing synthetic patient/appointment/note references. Failure must
   remain closed without changing unrelated account login or data ownership.
4. Fresh full iPhone and Desktop production compilation after review, exact
   helper/source receipts, signing and package inventory checks. Prepare a new
   receiver/image composition from all 12 verified identity inputs and the new
   exact patch. Preserve the already-verified Core frontend bytes if unchanged,
   but reseal the changed overlay/image with actual checks; do not rename old
   image or compile receipts.
5. Independently review the exact activation configuration and image/package
   hashes before any permitted production operation. The owner-designated
   synthetic canary must log in, access an existing authorized encounter, record,
   save, reopen and reach the same Core dashboard data. Check capture continuity,
   revoked access and isolation from unrelated users. Client submission follows
   the verified final production packages, with notifications governed separately.

Until gates 2–5 pass, the profile is source-only, disabled and unqualified for
operational production. A passing signed-token fixture is not a real canary.

## Recovery

Keep the existing platform's Clerk login, grandfather policy and clinical data
unchanged. If the capture canary fails, hold client distribution and the Scribe
activation gates while retaining the failed-run evidence and original records.
Do not reparent data, replace user subjects, auto-create organizations, waive Core
authorization or reuse a previous receipt as recovery. Reverting source alone
does not undo an applied schema/access operation; any such later operation needs
its own reviewed recovery plan.
