# Native existing-patient receiver consumer — Tier 2

This leaf starts at merged Scribe b5092b1 (including the receiver seal correction)
and consumes Core existing-patient facade source dfb7fde, dependent on provider
context 5fe61be. Independently review exact paired commits; keep controls false
and complete receiver-first source/image disposition before any activation.

Only Core-context mode can select the new fixed native encounter path. The
legacy receiver and `ProviderEncounterTransport` retain their exact blobs.
The original encounter flag remains false by default. When deliberately enabled,
catalog advertises the existing-patient subset; each patient search/create uses
fresh Core context before credential acquisition, immediately before dispatch
and after response. The human bearer and workload token stay separate. Core
denial, malformed/ambiguous response, redirect, changed current context and a
lost response return unavailable without retry or alternate path.

Creation passes the retained exact key and existing patient ID. The unchanged
Core writer rechecks current doctor/practice/member/tenant/record authority,
deduplicates the request, audits metadata and gates commit. Native setup accepts
Production account display only through this explicit catalog capability. It
queries current patients, escapes display text and waits for explicit selection.
Unsupported new/provisional creation is refused before creating a journal;
an already uncertain request keeps its original journal. DOB, patient matching
and private-note controls are not exposed by this closed subset. Staging's
walk-in setup, default account parser and existing retry behavior remain.

This completes source for patient search and existing-patient visit entry, not
full operational Start-to-Save parity. Existing admission and first-window
preparation remain behind original gates. Generic mutation/source-start
fallback still needs a separate closed native consumer before global Agent API
can stay disabled through Save. No live workflow qualification is claimed.

Owner-held prerequisites remain actual Clerk/session/org policy, current
practice/tenant authority, schema/Entra/RLS, scoped identities/grants/network,
qualified paired images/non-root processes and accepted cohort/canary/recovery.
No real patient, tenant, receipt or attestation is invented. No production,
Azure/configuration/Clerk/SQL/image/deployment action occurs in this leaf.

Before deployment discard/revert. After separately approved deployment stop
visit submissions and new capture admission/pickup, retain uncertain creation
keys, drain accepted work and restore the prior qualified compatible pair with
the receiver encounter flag false. Preserve visits, receipts/audit, schemas,
mappings, ciphertext and keys; network/grant revocation needs a separate owner
plan after drain/SAS expiry. Never select registry/CLI fallback or erase data as
immediate rollback.
