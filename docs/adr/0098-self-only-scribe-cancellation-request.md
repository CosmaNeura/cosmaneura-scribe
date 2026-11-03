# ADR 0098: Separate Scribe cancellation from shared sign-in deletion

Status: source implementation; receiver/Core integration and live qualification held.

Cancellation targets the authenticated doctor’s Scribe access and processing,
while preserving the shared Cosmaneura/Clerk identity and other practice members.
Use the fixed Core cancellation endpoint, independent of a mounted encounter, so
own status remains recoverable after processing is fenced. Core remains the
authority for scope, the 90-day read-only/export period and processing refusal.

Native clients keep only encrypted, account-keyed retry metadata through existing
device custody. They retain the original confirmed request after uncertainty and
discover the server’s own receipt before retrying or showing a new confirmation.
No renderer supplies a doctor, tenant, credential, network destination or erasure
authority. Stop the owned source before submission; keep normal Sign out.

An accepted cancellation is not completed destruction. The expanded owner policy
includes account Core PHI at eventual destruction, with a certificate; this slice
does not implement that destructive authority, backup cleanup or certificate.
The existing normal Scribe-copy retention design does not authorize a Core purge.
See the [flight plan](../flight-plans/2026-11-02-scribe-cancellation-native-request.md)
for exact dependencies, acceptance and recovery.
