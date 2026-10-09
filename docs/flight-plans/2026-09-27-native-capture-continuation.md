# Native capture continuation: receiver-first integration

Tier 2: a native recording capability and its retained ownership chain.
Current authorization covers isolated local synthetic implementation and
checks. This plan does not grant environment changes or deployment authority.

## Expand and validate

1. Apply additive revision `b0d93127cafe` after `611c583b362a` in a fresh owned
   synthetic database. No existing row is rewritten or backfilled.
2. Reconcile the source-extension receiver and lease-state read with current
   Scribe. Keep existing consent, source-start/stop and recording capacity.
3. Exercise real PostgreSQL migrations, exact role grants, tenant isolation,
   two renewals, receipt replay, expiry, original-owner Stop, revocation, and
   extension history retention. Regenerate OpenAPI and run local lint/types.
4. Record final source SHA and local implementer review in the receiver PR.
   Under the September 25 owner decision, local evidence substitutes for
   hosted checks/approving reviews. Do not describe it as independent review.
5. Verify the receiver's request/response contract against Core's prepared
   continuation projection before advancing the Core sender.

## Deployment dependency

Reconcile the actual deployed Scribe image/schema/configuration separately.
Receiver schema and source precede Core's sender and native consumer. Enabling
Scribe's continuation setting, Core's long-visit setting, or deploying an image
requires the relevant approved activation plan. CosmaBot remains separately
hosted; its code is not deployed into the Cosmaneura application.

## Recovery

Disable continuation admission and retain the table and all rows. Existing
recordings keep their original stop owner; no capability grants indefinite
capture. Stop remains callable through the original source-start receiver.
Lease-state observation does not issue new authority. Reverting the application
is compatible with the dormant additive table; it is not evidence that a
physical microphone has stopped. No native process is stopped or replaced by
this source-only change.

Alembic downgrade deliberately refuses to remove extension history, even when
empty. The local rehearsal verifies schema version, row count and RLS remain
unchanged after that refusal. A future destructive cleanup requires its own
approved contract rung. Real-device continuity, identity and deployed-service
acceptance remain distinct from these local checks.
