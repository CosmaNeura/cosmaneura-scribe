# 0095 — Dormant native capture and note workflow through existing Core authority

Status: proposed, source only. Tier 2. Owner activation and production access remain
reserved. This follows ADR0094's existing-patient visit entry and ADR0093's dormant
three-existing-Core-container option; it does not activate either architecture.

The existing native facade intentionally accepts reads and prepared Start steps.
Ordinary lease/chunk/completion and note Save requests still used the generic Agent
API, which remains disabled. Use three closed native actions under the existing
false-by-default existing-patient control. Reuse Core's current encounter/token
exchange, capture gateway, consent admission and note/save/resolve/status functions;
share the original note request model. Do not enable global Agent API, Authority
Kernel, Session Prep, capture, notes, source or long-visit controls.

Only Core-provider-context mode with its existing-patient control selected installs
the new receiver routes. Legacy registry mode and its receiver bytes remain intact.
Native reads keep the original qualified parser. Source Start uses the established
lease, native-owner proof, prepare/authorize keys and exact pair validator; ordinary
renderer operations cannot submit owner actions. Every request rechecks the verified
human session, native workload and current Core account. Denied, ambiguous, lost,
changed or expired replies return unavailable with no generic fallback or retry.
Optional combined note-opening is not advertised; ordinary note/template reads work.

The existing three-container loopback relay needs100 seconds for notes/admission to
avoid cutting off Core's existing90-second deadline. This does not extend consent,
source, lease or any Core authority deadline. Accepted but unconfirmed operations
retain their original keys and encrypted journals for explicit status/retry recovery.

Open holds: receiver-first contract and exact merged client/image qualification;
Core/Scribe PostgreSQL schemas, roles, Entra settings and current authority bootstrap;
private Blob/Key Vault connectivity and precise grants; same-container MI trust and
account-wide Blob Contributor reduction before the held identity attachment; exact
Clerk policy/receipts, target practice/cohort and owner canary/activation decision.
No resources, schema, mappings, dependencies, credentials, production writes or
images are created. New/provisional patients, matching, DOB and private-note mutation
remain unsupported. Source checks do not claim end-to-end clinical/production parity.
