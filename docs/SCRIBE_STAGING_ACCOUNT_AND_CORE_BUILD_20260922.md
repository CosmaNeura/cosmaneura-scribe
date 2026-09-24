# Staging account qualification and Core build — September 22

The four local source packets are adopted. The owner subsequently approved both
read-only 1Password lookups, the exact temporary single-IP database firewall
rule with cleanup, and the separate local Core image builder. Those approved
actions are complete.

## Live staging findings

`john@cosmaneura.com` uses the approved Cosmas Development issuer
`https://resolved-emu-53.clerk.accounts.dev`. The resolved Core staging public
Clerk key matches that issuer. The verified account has an existing, non-deleted
admin doctor record, a verified and unrevoked human identity, and an active
provider membership in an active Core authority tenant.

The account has **no practice membership**. Staging also lacks the
`scribe_capture_provider_link` table. Its live Alembic revision is `9a2399212488`,
eight additive Scribe migrations behind the approved local assembly's
`c8526f5e8d80`. The first missing migration creates the provider-link table.
The source migration graph had already passed its private fixture qualification;
it was not rerun or applied to staging here.

The existing account can be used as the identity for staging qualification, but
these findings do not establish clinical authorization or a working Scribe
provider workflow. An admin role and authority tenant membership do not supply
the missing reviewed practice/provider/Scribe mapping. BAA, entitlement, consent,
and encounter authority were not inferred or changed.

The approved temporary rule for `47.203.122.49` was added solely for the bounded,
TLS-verified read-only lookup. It was removed afterward and the original Azure
firewall rules were verified restored. No patient, encounter, note, transcript,
or audio content was queried. The database transaction was rolled back.

[Actual lookup and cleanup receipt](/Users/jw/Desktop/Cosmas/scribe-staging-provider-read-20260922.97g0690m/network-access-review/execution-result.json)

## Build progress

- API/worker and receiver Linux images remain built and archived locally.
- The full unsigned iOS archive and disabled Electron review app remain built,
  uninstalled, and unlaunched.
- Core's staging UI now compiles successfully using the existing Node 22.23.2
  and pnpm 9.15.9 toolchain and the approved public settings. It produced 157
  verified static files, approximately 3.24 MB.
- The Core backend build context contains all 1,487 approved source files,
  those 157 static files, and the three generated Nixpacks build files. The
  compressed archive is 7,475,556 bytes; SHA-256
  `d842a713b335ff4e79922d2e9d9ca45269d88737f0221e2d18f666acdb16ee7c`.
- The Core Linux amd64 image is now built and exported as
  `scribe-local-h91ly9kp-core:20260922`. Its image ID is
  `sha256:e229f127b1f3ae419223075f7b29f715212d4a4df9fd7c326833ab9812b7c743`.
  All 462 checked packaged application, migration, public-asset and build-input
  files match the approved context. The 615,742,464-byte image archive has
  SHA-256 `191f80f0abebbbae47d0cc58339d643285d1baa56159135c2cfe74e33f8ac80d`.
- The initial shared Docker VM ran out of space during dependency setup. Only
  this task's failed build container and newly created disposable cache images
  were removed. The separately approved 2-CPU/4-GiB isolated builder completed
  the build and export, removed its stopped inspection container, and stopped.
  It had no host directory mounts and used only its explicit Docker socket.
- Core's existing image entrypoint supports its process roles. The default is
  the worker; the API uses the existing `python main.py` command supplied by
  deployment configuration. No Core application process was started here.

During final cleanup, local inspection found the shared Docker context missing
and the original VM temporarily stopped. The global Docker configuration had
changed at 20:45:49, before this task stopped its isolated VM at 20:47:58. The
original VM's configuration changed again at 20:49 and it returned running with
a 90-GiB disk, compared with the earlier 40-GiB disk. This task did not perform
that reconfiguration or restart. A single attempted restoration of the original
`colima` client context failed because that context was absent; it made no
change. The current shared runtime state was left untouched. No other task was
contacted or inspected; these findings came from local runtime metadata.

[Core build archive receipt](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/adoption/core-image-build/artifacts/core-build-archive.json)
· [Completed image build/export receipt](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/adoption/core-image-build/artifacts/core-isolated-build-result.json)
· [Approved builder scope](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/adoption/core-image-build/LOCAL_BUILDER_PROPOSAL.md)

## Remaining operational work

Review and apply the shared-Core staging release and eight migrations;
establish John's practice/provider/Scribe mapping; bind the
ciphertext upload host, managed identities, runtime database principals and
ingress; and qualify the installed desktop/mobile workflow through creator
review and Core note creation. Issued-but-unconfirmed start/orphan recovery
remains unfinished. All activation flags remain off and no runtime mapping was
automatically filled from the database IDs.

These results add live account/schema evidence and a real Core UI build. They
are not installed acceptance or proof that the full workflow is operational.
