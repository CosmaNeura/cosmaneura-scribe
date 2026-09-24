# Shared Core deployment decision — 2026-09-22

## Owner decision

The owner explicitly chose existing Core as the owner of users, workspaces,
encounters, SOAP notes and dashboard records. Run Scribe capture processing
alongside it in the existing infrastructure, with separate worker capacity,
encrypted recording storage and access controls. Scribe and CosmasOS use the
same reviewed integration: a completed recording/review attaches to the existing
Core encounter. Qualify isolated test data before enabling the provider cohort.

This resolves the earlier environment architecture question. Do not ask the owner
to choose between a disconnected Scribe Core and the existing provider Core again.
It does not authorize a deployment, shared Core edits, authentication changes,
new resources, migrations, PHI or cohort activation. Prepare exact configuration
and promotion decisions within the existing boundaries before requesting approval.

## Read-only infrastructure findings

Evidence directory:
`/Users/jw/Desktop/Cosmas/scribe-desktop-host-20260922.3e7wlxvy/`.
Azure management metadata was inspected; no clinical API, dashboard, authentication
or live-service qualification request was made, and no resources were changed.

- Production: `cosmaneura-prod-app`, resource group `cosmaneura-prod`, North
  Central US; domains `app.cosmaneura.com` and `chat.cosmaneura.com`.
  Latest and ready revision: `cosmaneura-prod-app--r33451670627a1-8fa02a7`.
  Observed image tag:
  `cosmaneuraprodregistry.azurecr.io/cosmaneura/cosmaneura:8fa02a71f4b880cd43f4fccc8c81c92a0d635623`.
- Staging: `cosmaneura-staging-app`, resource group `cosmaneura-staging`;
  domains `staging-app.cosmaneura.com` and `staging-chat.cosmaneura.com`.
  Latest and ready revision: `cosmaneura-staging-app--r1789668418a1-ace8197`.
  Observed image:
  `cosmaneurastagingregistry.azurecr.io/cosmaneura/cosmaneura@sha256:a2c2a736651b7d24965da0866836c0de027e3589dcecdf825d4dc2e5a51d42cc`.
- Separate production/staging worker and scheduler apps exist. Inventory alone
  does not establish approved Scribe capacity, encryption, retention or access.

The local Core checkout is
`/Users/jw/Desktop/Cosmas/cosmas-os-core-integration`, HEAD
`e21ba4c1fb1027de8123aca9b8aee25b8a11b612`, with a pre-existing dirty tree.
It was inspected read-only. Its local capture integration is not a releasable
snapshot merely because local workflow checks passed.

The local Git object matching the production image tag lacks seven capture
integration files: `app/routes/scribe_capture.py`,
`app/configuration/scribe_capture.py`, the admission, notes, reviewed-source and
gateway services, and the reviewed-source model. The workflow configuration
exists at that commit. Exact paths/hashes are in
`core-tag-commit-comparison.json`. **The tag is mutable: this is source-associated
evidence, not verification of the running image digest or enabled route gates.**

## Next integration work

Reconcile the actual deployed immutable image/configuration with the bounded
capture consumer before pointing either standalone client at it. Prepare a
receiver-first release/configuration packet; do not deploy the dirty Core tree.
Confirm the isolated Core user/workspace/encounter correspondence, service
workload identity, upload/storage access, provider receiver reachability and
existing creator/dashboard route. Clerk user JWTs are not Entra workload tokens.

The prepared iOS transport (`scripts/standalone-provider/ProviderNativeTransport.swift`)
currently accepts only an explicit RFC1918 IPv4 HTTPS endpoint on port 1024–65535,
with a bundled CA and leaf pin scoped to its URLSession. A public Core hostname
or ordinary port 443 is not interchangeable with that qualified receiver profile.
Prepare the approved mobile access/receiver profile alongside Core; any extension
of this native trust boundary needs its exact scope reviewed. The separate
provider receiver also requires provisioned Core observations/account mappings;
it does not create encounters or supply upload/navigation configuration itself.

Local reviewed-source/notes code binds the existing appointment and Core note
records. Shared hosting alone does not establish recording/transcript visibility
in a provider dashboard. Qualify that association and access with isolated data,
then physical clients, before cohort enablement. Historical insurance pilot
resources do not define the current Scribe-plus-CosmasOS product scope.
