# Scribe isolated micro-beta environment plan

**Status:** Pre-implementation plan; no Azure apply, identity configuration, provider registration,
deployment, or cohort activation is authorized by this document.

## Objective

Create a dedicated synthetic-only Core/Scribe runtime and data plane for the micro-beta while
reusing the existing Clerk human-identity architecture and the same client-facing contracts that
will be used at clinical activation. Beta credentials and data must not authorize or reach
production resources, and production credentials and callbacks must not be copied into beta.

## Boundary

The beta environment requires distinct:

- infrastructure state and resource group;
- Core beta API/BFF runtime and database projection;
- Scribe API, worker, PostgreSQL database, Blob storage, Key Vault, Speech, and translation
  resources;
- private networking, DNS, workload identities, role assignments, queues/jobs, and diagnostic
  sinks;
- Recall callback secret/configuration and Zoom-bot beta registration if fallback is enabled; and
- feature flags, cohort grants, retention settings, kill switches, and immutable deployment
  evidence.

The existing Clerk identity provider and Core authentication implementation remain the human login
plane. Beta authorization is separate, server-side state: exact invitation or existing approved
identity, fixed beta practice, active Scribe beta grant, allowed client, and `synthetic_only` data
mode. A Clerk session accepted by beta does not gain production Scribe authority.

## User continuity

- Desktop and iOS always open the Core system-browser authentication flow; neither contains a Clerk
  secret or a separate username/password UI.
- The beta and live clients consume the same versioned launch, token, encounter, status, and review
  contracts. Environment selection is signed/server-controlled and is not a user setting.
- The same verified Clerk subject is used for beta and live. Beta-specific membership and grants
  live only in the beta authorization projection; production membership is not rewritten.
- Clinical activation requires a preflight proving that the production identity, practice, role,
  legal/credential state, and Scribe entitlement are ready before any routing change.
- No account migration, credential conversion, or second human authentication system is permitted.
  Any failed login/session/refresh/recovery rehearsal blocks activation.

This design minimizes auth-transition risk but cannot guarantee that an identity provider, browser,
device, or network will never fail. The product commitment is a tested no-regression release gate
and a rollback path, not an absolute availability claim.

## Required topology

```text
Existing Clerk issuer
        |
        v
Isolated Core beta API/BFF + beta authorization/database
        |
        | private workload identity and network path
        v
Isolated Scribe beta API/jobs
        |
        +-- PostgreSQL
        +-- encrypted Blob storage and Key Vault
        +-- Azure Speech
        +-- approved Spanish-to-English translation boundary
```

No Scribe API is exposed directly to desktop or iOS. Clients talk only to the Core beta BFF. Core
derives tenant, creator, patient, appointment, consent, and data mode, then calls Scribe using a
short-lived managed-identity token. Scribe returns transcripts through the private, idempotent Core
handoff.

## Staged provisioning

1. **Inventory and address plan:** record current subscription resource names, regions, quotas,
   VNets, DNS zones, app registrations, Clerk origins/callbacks, provider registrations, state
   lineage, and CIDR allocations. Select a non-overlapping beta address range only from that
   evidence.
2. **Offline validation:** add a distinct beta backend key and variable example, run formatting and
   validation, and inspect a saved plan that contains no development or production resource
   addresses.
3. **Foundation apply:** after explicit approval, create only resource group, network, private DNS,
   logging/budget baseline, identities, storage, Key Vault, database, Speech, and translation
   foundations. Application and provider gates remain false.
4. **Private-path proof:** deploy an immutable non-PHI Core/Scribe image pair, migrate the empty beta
   database, and prove private DNS, managed identity, health, and synthetic handoff without a client
   or provider.
5. **Identity and invitation proof:** configure reviewed beta origins/callbacks, accept one exact
   founder-issued invitation, prove owner/tenant isolation and revocation, and keep capture false.
6. **Provider proof:** configure exact beta Recall/Zoom callback boundaries, run observation-only
   platform discovery, and prove Desktop-versus-bot source arbitration before enabling audio.
7. **Client proof:** distribute exact signed desktop and TestFlight artifacts only after their full
   synthetic acceptance matrices pass.

Each rung has a saved pre-change plan, immutable source/artifact identity, explicit approval,
post-change evidence, and its own recovery action. Passing one rung does not authorize the next.

## False-default controls

At minimum, separate controls cover:

- beta admission;
- synthetic encounter creation;
- desktop launch and real Recall capture;
- Google Meet and Zoom Desktop allowlists;
- Zoom-bot fallback;
- iOS distribution and native capture;
- English/Spanish language identification;
- Spanish-to-English translation;
- English working-transcript note dispatch; and
- clinical/PHI activation.

All controls default false. The clinical/PHI control is absent or false in beta and cannot be
overridden by a client, invitation, environment variable supplied at request time, or another
feature flag.

## Acceptance and rollback

Before cohort enrollment, prove resource and data isolation, creator-only access, invite lifecycle,
token revocation, network denial from public/unapproved paths, exact-artifact provenance, bounded
cost/retention, no-sensitive-data diagnostics, backup/restore for non-PHI beta state, and environment
kill switches.

Before live activation, repeat the authentication matrix with every named beta identity against the
production control plane and prove that the same signed client and user workflow deliver only to the
authorized production dashboard. Any discrepancy blocks activation.

Foundation rollback deletes nothing automatically. Disable new traffic and provider actions first,
retain evidence, reconcile in-flight synthetic sessions, and use a separately reviewed cleanup plan
for disposable beta resources only after confirming that no required evidence remains.

## Open implementation inputs

- Exact beta hostnames and Clerk allowed origins/redirect URIs.
- Subscription-wide CIDR and private-DNS collision check.
- Core beta infrastructure ownership and state location.
- Whether Azure Speech and translation use separate accounts or one approved multi-service account.
- Dedicated beta Recall workspace/account and Zoom app/callback ownership.
- Budget, retention, operational owner, incident contact, and cohort expiration date.
