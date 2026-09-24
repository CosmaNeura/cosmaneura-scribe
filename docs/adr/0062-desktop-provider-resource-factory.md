# ADR 0062 — Desktop provider resource factory

Date: 2026-09-22

Status: local connection composition verified; native/backend profile still required

## Outcome

`createDesktopProviderConnection` now joins an authorized desktop backend to the
existing provider main host. It opens real encrypted SQLite storage only after
backend encounter authorization and native custody acquisition. It reuses the
provider/review journals, durable flow/queue/key/coverage stores, CoreCaptureClient
and DesktopProviderRecorder. It freezes the selected scope before asynchronous
storage work, checks the saved admission before recorder acquisition and preserves
journals after the recorder view is released.

The connection owns late custody/storage/recorder results. Encounter replacement
and teardown wait for confirmed native stop before closing stores or releasing
custody. Failed stop or custody release retains the same cleanup owner for retry.
The factory starts no source, supplies no credentials or identity, and does not
manufacture the desktop grant or one-time start capability. Its native resources
remain explicit dependencies; omitted enablement is rejected.

This is the durable connection portion of the native/backend factory. It is not
the complete packaged `standalone/provider-host.mjs`, which is still absent.
Do not replace that missing module with fixtures or an unavailable-session shim.
Actual native auth, key custody, picker/indicator and desktop backend start-authority
transport remain open. The Electron and standalone iOS identity proposals remain
unapplied. The [Core release packet](../beta/SCRIBE_CORE_RELEASE_PACKET_20260922.md)
records the freshly observed configuration and issuer gaps.

## Verification and recovery

Tier 2 under the existing approved local provider-controls flight plan. No new
auth policy, consent policy, transcript schema, dependency, environment, service,
installed app or protected authority source changed. Recovery leaves the new
factory unmounted and preserves encrypted work. Core/OS checkouts remain read-only.

Evidence is in `build/core-release-20260922/` in the existing Scribe checkout.
Four new connection checks and twelve existing main/packaged-host checks pass.
They cover real-file journal recovery, wrong-key rejection, late and synchronous
revocation, admission/Core binding and failed-stop ownership/retry. Native session,
key custody, recorder and backend responses are invented test inputs; no physical
audio, Keychain, Electron runtime or clinical endpoint was used. Existing completed
Swift, W13, Speech/translation and UI trials were not repeated.

Desktop typecheck, affected lint and a standalone esbuild compilation pass. The
actual compiled factory imports under Node 24 without acquiring resources. The
initial fixture response omitted the required Core envelope metadata, and one
fixture literal widened its application type; both were corrected. An initial
lint pass also identified method typing and a redundant async marker, corrected
without changing the runtime policy. No unresolved check failure remains.

Installed desktop/mobile workflows, native lifecycle, physical/offline recording,
bilingual fidelity through Core SOAP, signed updates/rollback and operating
acceptance are still required. This increment does not change the beta readiness
estimate or establish any new installed acceptance.
