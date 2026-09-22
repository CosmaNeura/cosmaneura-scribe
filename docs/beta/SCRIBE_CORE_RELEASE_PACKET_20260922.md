# Shared-Core release and provider configuration — 2026-09-22

Status: read-only reconciliation and proposed sequence; **no activation approved**.
Existing Core remains the owner of users, workspaces, encounters and SOAP. This
packet does not reopen the [shared-Core decision](SCRIBE_SHARED_CORE_DECISION_20260922.md).

## Current evidence

Read-only Azure management and registry metadata, collected September 22, is in
`build/core-release-20260922/` in the Scribe checkout. No clinical route, database,
container shell, login, Speech or translation trial was invoked. Environment
names and selected non-secret integration settings were inspected; secret values
were not requested. An initial CLI attempt failed on local command-log permission,
then sandbox DNS; the successful read-only queries used disabled CLI file logging
and approved network access. No Azure configuration changed.

| Observation | Production | Staging |
| --- | --- | --- |
| Active/healthy revision | `cosmaneura-prod-app--r33451670627a1-8fa02a7` | `cosmaneura-staging-app--r1789668418a1-ace8197` |
| Revision created | 2026-08-31 23:55:23 UTC | 2026-09-17 18:18:59 UTC |
| Traffic | 100% | 100% |
| Image reference | Mutable tag `8fa02a71f4b880cd43f4fccc8c81c92a0d635623` | Digest `sha256:a2c2a736651b7d24965da0866836c0de027e3589dcecdf825d4dc2e5a51d42cc` |
| `SCRIBE_WORKFLOW_ENABLED` | `false` | `false` |
| Capture flags, upload origins, service base URL and service scope | Absent from revision environment | Absent from revision environment |
| Agent API and authority kernel flags | Absent from revision environment | Both `true` |
| Configured Core Clerk issuer | `https://clerk.cosmaneura.com` | `https://resolved-emu-53.clerk.accounts.dev` |
| Container App workload identity | Existing user-assigned Scribe workflow identity | None |

The production tag currently resolves in ACR to
`sha256:a2a1a69874c193ef538d42b72cf526ef6da183a0cced72cd67a3a017d38eb6dc`.
Registry creation/update metadata is August 31, 23:51:06 UTC. This establishes the
current tag binding, **not the digest loaded by an existing production replica**.
The staging revision is pinned by digest, but its image contents, route behavior
and database revision have not been inspected. Azure's Healthy state does not
qualify the clinical workflow. Absent environment variables are not proof that
an image lacks an embedded default or configuration file.

The read-only Core checkout remains at `e21ba4c1fb1027de8123aca9b8aee25b8a11b612`
with 82 pre-existing dirty paths, recorded individually in `core-local-before.json`.
The seven capture files previously found missing at the production tag's Git
commit remain a source gap; the local dirty integration is not a release artifact.
Do not deploy it or infer image contents from its tests.

## Identity and workload blockers

The retained native W13 configuration and pending standalone iOS packet use
`https://sharp-bluegill-3253.clerk.accounts.dev`. Neither active Core issuer matches.
An identical organization display name does not bridge those issuers or subjects.
The new bundle identity alone cannot fix this. Keep its exact proposal unapplied
until approved; even after that approval it remains insufficient for Core access.

The recommended first environment is the **existing staging Core**, with isolated
provider/patient/appointment records and its existing issuer. Prepare a separate
exact native issuer/public-key/organization/account mapping amendment before using
that identity. Do not widen Core to accept the diagnostic issuer, repurpose W13,
copy its credentials, or change the production issuer. No amendment is applied here.

There are two distinct server workload directions:

1. Provider receiver → Core Agent API: staging currently permits the single client
   `8cb2ecb5-3554-4405-be6f-5eda985c2f04`, audience
   `af957741-0342-498b-8496-e93706af9e99`, role `AgentApi.Access`.
   This metadata does not establish that the new receiver owns that identity or
   its credentials. Reuse requires an explicitly reviewed assignment; adding a
   second caller also conflicts with Core's current one-client policy.
2. Core → Scribe workflow API: role `Scribe.Workflow.Access`, exact Scribe audience,
   tenant and trusted Core caller, plus a scoped token source. Production's
   existing identity client ID is `c7bae168-fbf5-4658-b0d9-dd4b5373a1be`; it is not
   attached to staging and is not permission to reuse production credentials there.

Clerk user tokens remain user authority. They never substitute for either workload
token. The receiver reuses Core's user-context exchange and mount/binding routes.

## Receiver-first promotion sequence

1. Assemble a reviewable Core source candidate from the exact local capture delta
   against the intended released baseline, preserving unrelated Core work. Owning-
   repository release preparation is a separate scope; Core stays read-only here.
   Bind source/tree, build inputs and immutable image provenance. Reconcile every
   source/config/schema difference as retain, assimilate or replace before promotion.
2. Reconcile the target schema read-only before proposing an expand. The local
   chain is `9a2399212488 → 3b34d21be057 → cbd4ef4c37d5 → f2388a506337 →
   ea61b75ac5b0 → b8d3e1ba9d08 → 05972a4ee86c → 9172abd84a3d → c8526f5e8d80`.
   This is the capture chain, not a claim about the complete current migration graph.
   Review an exact target-specific migration/restore rehearsal and row-preservation
   receipt. Recovery leaves additive structures dormant; no destructive downgrade.
3. Qualify the Scribe receiver and separate workers/storage in the existing
   infrastructure before enabling the Core consumer. Supply exact Scribe image,
   PostgreSQL/runtime and worker roles, encrypted recording container, Key Vault key
   version, encrypted assembly workspace, retained Speech/translation configuration,
   retention/access policy and restore evidence. Existing resource inventory does
   not select these values. Reuse completed service trials without rerunning them.
4. Prepare the Core consumer configuration: `SCRIBE_CAPTURE_ENABLED`,
   `SCRIBE_CAPTURE_NOTES_ENABLED`, `SCRIBE_WORKFLOW_ENABLED`,
   `SCRIBE_SERVICE_BASE_URL`, `SCRIBE_SERVICE_SCOPE`,
   `SCRIBE_MANAGED_IDENTITY_CLIENT_ID`, `SCRIBE_CAPTURE_UPLOAD_ORIGINS`, and the
   existing Agent API/authority settings. Keep unrelated legacy handoff and optional
   prep/long-visit/working-source/recovery flags at their reviewed values; do not
   enable every flag merely because it exists. Exact upload origins must be HTTPS
   at port 443 under the current Core validation.
5. Provision reviewed isolated correspondence on both sides. Core needs its current
   human external identity, actor/tenant/provider membership, doctor/practice access,
   patient/appointment and `ScribeCaptureProviderLink` (including Scribe tenant and
   immutable review evidence). The provider receiver needs the matching active
   external identity/CoreCaptureAccount and creator-owned EncounterWorkspace with
   confirmed Core appointment/patient observations. Neither UUIDs nor catalog rows
   grant authority. Do not seed a shared database or invent these mappings here.
6. Qualify the six-route provider receiver, native upload and existing Core
   navigation/creation callbacks against those records. The current receiver does
   not create encounters, synchronize new Core observations, upload ciphertext or
   supply navigation. These are implementation/configuration gaps, not done steps.
7. After exact deployment/configuration authority, enable only the isolated test
   scope and perform the new complete workflow: encounter → consent → capture →
   reviewed translation → Core SOAP → existing creator/dashboard. Verify actual
   recording/transcript/note association and revocation, then desktop/mobile
   installed acceptance. Cohort activation remains a later decision.

No deployment command is supplied with unresolved source, schema, workload and
identity inputs. A runnable promotion proposal must bind those exact values and
its recovery before the owner is asked to dispatch it.

### Existing creator/dashboard source contract

The sparse Core checkout omits its web files, so their existing Git objects were
read without materializing or editing them. At `e21ba4c`, `web/app/routes.ts`
defines `/notes/:id`; `web/app/routes/notes/detail.tsx` passes that **appointment
ID** to Core's authenticated `/notes/{appointment_id}` API. A visit-note ID is not
the page route. `core-ui-source.json` binds these source observations. No live
page was opened and no navigation callback was configured.

There is a further release-reconciliation issue: the existing
`app/routes/internal.py:note_detail` reads one transcript by appointment using
`AIVisitTranscript.get(appointment_id=...)`, with an explicit one-transcript
assumption. The dirty `scribe_capture_reviewed_source.py:import_source` retains a
new canonical transcript for each subsequent reviewed working version. The
dashboard route does not select that reviewed version. Its behavior with multiple
retained transcripts has not been executed here; it needs an owning-Core change
and targeted acceptance before calling dashboard association complete. Keep the
old transcripts and note provenance. Opening a valid URL alone is insufficient.

The inspected note UI offers the existing recording-upload flow; it does not
establish a pre-recording encounter-creation callback for the new provider host.
Resolve creation and refreshed receiver observations through the existing Core
workflow rather than treating a recording upload or a locally invented encounter
as that callback.

## Mobile access profile

Preserve the current native transport: one canonical RFC1918 IPv4 HTTPS endpoint,
an explicit port from 1024–65535, bundled CA DER and exact leaf SHA-256, scoped to
its ephemeral URLSession. No redirects, system-trust changes or public-host/443
fallback. The receiver must preserve exact Host and `capacitor://localhost` Origin;
its current boundary rejects forwarding headers. A default reverse proxy is not
automatically compatible.

For initial isolated qualification, propose a **separate receiver on a reviewed
phone-reachable private network**, with new owned TLS/DB/runtime inputs and a stable
environment UUID. Do not use W13's port 8446, PostgreSQL port 55462, certificates,
database or two-route app. The private IPv4/port, certificate lifetime, connectivity
to existing staging Core, workload source and isolated mappings are still unknown.
Off-network provider operation needs a reviewed access path; a local LAN profile
does not satisfy operational mobile access. Extending native public-host trust or
introducing VPN/network services needs its own exact proposal.

## Desktop factory boundary

The existing recorder needs `BackendCaptureGrant` and a fresh
`TrustedCaptureAuthority.authorizeStart()` decision carrying the same creator,
consent, session and source lease with a one-time capability. The current provider
receiver's `recorder` action returns only `revision` and `session_id`; Core's
capability receipt is not that start decision. A factory must not manufacture the
grant/capability locally or derive it from a Clerk JWT. Reconcile the backend
contract and prepare its exact server-side scope before implementing that boundary.
Preserve both protected authority file hashes.

Real native session ownership, device key custody, picker, persistent indicator,
upload and Core navigation must also be supplied by the approved native profile.
Local durable-store/recorder composition can advance independently; its fixture
evidence is not an installed or authenticated provider workflow.

## Recovery and authority

Retain both deployed Core revisions, every existing service/app and pending
encrypted record. This packet and its metadata authorize no schema, identity,
workload, network, storage, dependency, release, shared-data or cohort change.
The pending iOS and Electron packets remain separately scoped decisions.
