# Desktop runtime proposal — 2026-09-22

Status: **owner approved; exact dependency patch and local runtime install completed**.

The owner explicitly approved this dependency/install proposal on 2026-09-22.
Electron 44.4.3 is pinned in the desktop workspace and installed in this checkout.
Only the seven proposed package entries were added; no existing version changed.
The resulting lockfile is byte-identical to the approved proposal. Lifecycle
scripts were disabled during npm installation; the separately inspected Electron
installer then downloaded/extracted the exact arm64 runtime. Its archive SHA256
matches the approved checksum below. The current main/preload entry typechecks
against the installed declarations. No Electron process was launched.

The upstream runtime is ad-hoc/linker-signed, has no TeamIdentifier or sealed
resources, and fails strict app-bundle signature verification. It is a local
development dependency, not signed Scribe distribution evidence. No re-signing
or trust change was attempted. Evidence is retained at
`/Users/jw/Desktop/Cosmas/scribe-approved-platforms-20260922.wvwvqtad/`.
See [the applied checkpoint](../SCRIBE_APPROVED_PLATFORM_CHECKPOINT_20260922.md).

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
  At proposal preparation the zip had not been downloaded. The approved install
  now verifies the checksum and records the signature limitation above. Registry
  signatures were not independently verified. Checksums are not signed app provenance.

Actual main/preload entry source typechecks against these Electron declarations.
The sandboxed compiled preload exposes only the existing restricted bridges and
imports only Electron. Six host lifecycle/asset checks and the full compiled
review-to-Core-note fixture pass with fakes; no actual Electron process ran.

## Review scope and remaining work

Repository `AGENTS.md`, Permission boundaries, says **"New dependencies/services"**
are ask-first. The owner's explicit approval now covers this exact adoption and
local install; do not request it again. It does not extend the scope below.

Dependency adoption alone does not approve runtime launch, a native Keychain
implementation, Core/environment configuration or signed distribution. The
separate `provider-host.mjs` must supply the reviewed native session/backend,
native source picker and persistent indicator, device key custody and durable
stores. No default fixture, credential, environment or SDK is supplied by the
host. The host builder marks `launch_ready: false` and lists missing inputs.

Recovery leaves the new host unmounted; the dependency remains pinned for
reproducible preparation.
Do not rebuild/resign/restart Mac R2, reuse its data/credential namespace, replace
CosmaneuraCapture/W13 or alter existing receiver/TLS/database resources.
