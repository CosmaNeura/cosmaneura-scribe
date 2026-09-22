# Desktop runtime proposal — 2026-09-22

Status: concrete dependency proposal prepared; **not approved or applied**.

The complete provider workspace now has a dormant Electron main/preload entry
and fixed packaged renderer. Its actual native/backend factory is still absent.
Electron 44.4.3 is the proposed runtime because its embedded Node 24.21.0 supports
the existing Node 24 desktop implementation and SQLite path. Public release
metadata dates the release to 2026-09-18. This is not an installed-app acceptance.

## Exact prepared material

Evidence directory:
`/Users/jw/Desktop/Cosmas/scribe-desktop-host-20260922.3e7wlxvy/`.

- `electron-44.4.3-unapplied.patch`: desktop devDependency pinned to `44.4.3`
  and corresponding root lockfile. SHA256:
  `2097c21bdd49b7009b53065990e2c985d7a9a6c4768149405b4410b0c312b6b5`.
- `dependency-proposal-receipt.json`: seven added package entries; the only
  changed existing entry is the desktop workspace dependency declaration.
  No existing package version changed or package was removed. The proposal was
  resolved with npm 11.5.2, package-lock-only and install scripts disabled in an
  external disposable metadata directory. No `node_modules` was created there.
- Registry tarball SHA512 verified against published integrity:
  `sha512-LTpSFTB40qVCXIX5xMo+cgHI/Jjkbjw7VpB26PccEbroqOn72LBukeaDwPVo1fBYzSzs0c9iPuAucFCO7Tw81Q==`.
  Only declarations, metadata, license and installation source were extracted
  for inspection; package code/install scripts were not executed.
- Published `electron-v44.4.3-darwin-arm64.zip` SHA256:
  `6b728f5dcfae74f3f936f2bca5b3cd9b9659ffea464f67939f004acb55425a85`.
  The native zip was not downloaded, verified against this checksum, signature
  checked, installed or launched. Registry signatures were not independently
  verified. Published checksums are not signed app provenance.

Actual main/preload entry source typechecks against these Electron declarations.
The sandboxed compiled preload exposes only the existing restricted bridges and
imports only Electron. Six host lifecycle/asset checks and the full compiled
review-to-Core-note fixture pass with fakes; no actual Electron process ran.

## Review scope and remaining work

Repository `AGENTS.md`, Permission boundaries, says **"New dependencies/services"**
are ask-first. The owner has not approved this Electron dependency. Prepare the
exact adoption/install action and request only that missing scope; do not treat
this document, a checksum, or prior W13 launch approval as approval.

Dependency adoption alone does not approve runtime launch, a native Keychain
implementation, Core/environment configuration or signed distribution. The
separate `provider-host.mjs` must supply the reviewed native session/backend,
native source picker and persistent indicator, device key custody and durable
stores. No default fixture, credential, environment or SDK is supplied by the
host. The host builder marks `launch_ready: false` and lists missing inputs.

Recover by leaving the new host unmounted and the dependency patch unapplied.
Do not rebuild/resign/restart Mac R2, reuse its data/credential namespace, replace
CosmaneuraCapture/W13 or alter existing receiver/TLS/database resources.
