# ADR 0033: Gate least-privilege derived-writer database authority

**Status:** Accepted for dormant synthetic implementation

## Context

The normalized translation, creator-review, and English working-transcript tables are deliberately unreachable by deployed database roles. The correction-safe receiver and trigger definitions support narrow privileges, but a shared writer identity would let automated translation forge human review evidence. A separate projector identity would split evidence and canonical projection across transactions. Database authority must not expand merely because this code is merged, so bootstrap needs an explicit false-default gate and a tested return to baseline.

## Decision

Add the bootstrap-only setting `derived_writer_database_permissions_enabled`, defaulting to false, and an optional translation database-principal name/object-ID pair. Enabling it requires PostgreSQL, the complete runtime principal, and the complete, distinct translation principal. Every configured application principal must have a distinct role name and Entra object ID.

The API runtime remains the only database identity intended for Core-authorized creator reviews. When enabled it can:

- read the current source, translation, review, and working evidence needed by the projector;
- insert creator-review evidence and complete immutable working-projection rows; and
- update only session status, stable working identity, and current working version, including clearing the current version during source correction.

It cannot insert translation attempts or update/delete immutable derived evidence.

The new translation principal is intended for a future separately hosted translation job. When enabled it can read tenant-scoped projection inputs, insert translation attempts and complete immutable working projections, write metadata-only audit events, and update only the named working-pointer/status columns on scoped session rows. It cannot insert creator reviews or normalized source rows, update any immutable evidence, or receive legacy capture, transcription, delivery, idempotency, terminal-event, sequence, routine-execution, schema-creation, database-temporary, delete, truncate, trigger, or references authority.

On `scribe_sessions`, a restrictive policy additionally limits it to contract `1.0` external transcript rows in `translation_pending`, `review_required`, or `transcript_ready`, for both old and new update images. This prevents legacy access and transition to `handed_off`.

Both writers invoke the projector within their evidence transaction. There is no projector login role or `SECURITY DEFINER` function. Trigger functions remain invoker-security and receive the exact reads required for their constraints.

Bootstrap revokes each role's database, schema, table, sequence, and routine privileges before reconstructing the allowed set, then fails closed if a foreign-grantor ACL survived. The bootstrap login must be the database owner and sole non-superuser with effective `CREATE` on `public`; any owner's table, sequence, or routine defaults granting `PUBLIC` or an application role also fail closed. In the translation transaction bootstrap replaces only the current identity's UUID-derived restrictive policy, including while the gate is false. With the gate false, runtime returns to its pre-packet baseline and a configured translation role has zero application-database capability.

Application roles are rejected if they are superusers, bypass RLS, create roles/databases, replicate, inherit another role, or own any database object tracked by PostgreSQL. Bootstrap fails closed rather than changing memberships, ownership, foreign-grantor ACLs, or another owner's default privileges.

## Authentication and activation boundary

These PostgreSQL roles are service capabilities, not human identities. Clerk/Core remains the only provider login path. Core must freshly authorize provider, practice, session, and immutable creator before constructing a review command; Scribe's Entra workload identity proves the workload, not the clinician.

This packet adds no translation connection path, managed identity or app-role assignment, Core caller, route, OpenAPI operation, Terraform/environment value, migration, deployment, grant application, cohort enrollment, or activation. The gate remains false. Before a translation connection is enabled, it must pin its search path to `pg_catalog, public` and verification must exclude unintended non-public-schema access.

## Recovery and consequences

Bootstrap spans transactions. On partial failure, keep callers quiesced and identity metadata configured and set the gate false. Locate application-role ACLs through `pg_shdepend` (`deptype='a'`); locate `PUBLIC` ACLs by expanding the scoped catalogs with `aclexplode(COALESCE(acl, acldefault(...)))`, then inspect the object's ACL for its grantor. A `NOLOGIN` grantor requires an authorized operator to remove its upstream grant option with a reviewed `CASCADE`, accounting for other downstream grants. Default-ACL repair must run as, or be explicitly authorized for, its owner. Rerun bootstrap and verify exact privileges before removing configuration; no schema or immutable evidence is rolled back.

For rotation or decommission, first disable and revoke the old role's ACLs, then drop that principal's deterministic policy, and only then drop the role. Retaining old identity metadata through ACL verification is mandatory.

Activation requires separate approval for the translation managed identity/connection, Core creator authorization and durable idempotency caller, environment configuration, bootstrap run, and synthetic end-to-end evidence. Existing transcription and delivery-reconciler identities remain unchanged.
