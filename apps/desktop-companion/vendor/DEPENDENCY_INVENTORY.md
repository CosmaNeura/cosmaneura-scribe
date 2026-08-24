# Desktop companion dependency inventory

Status: review input only; not a signed release SBOM and not approved for PHI.

| Component | Version | Role | License status | Integrity source |
| --- | --- | --- | --- | --- |
| Electron | 43.4.1 | Desktop shell (development/runtime tooling) | MIT declared | isolated npm lock SHA-512 |
| `@electron/packager` | 20.3.0 | Unsigned application assembly only; built-in signing disabled | BSD-2-Clause declared | isolated npm lock SHA-512 plus checked-in policy integrity |
| `@recallai/desktop-sdk` | 2.0.28 / commit `62bf3a1f8995af470272b2198f39f2f53c150fdc` | Native capture wrapper | npm package does not declare a license; legal review required | npm lock SHA-512 plus independent registry tarball SHA-256 |
| Recall macOS native archive | SDK commit above | Apple Silicon native capture process/frameworks | vendor/legal review required | SHA-256 in provenance manifest |
| Recall Windows native archive | SDK commit above | x64 native capture process/GStreamer runtime | vendor/legal review required | SHA-256 in provenance manifest |
| `tar` | resolved by isolated lock | Reviewed archive extraction utility | BlueOak-1.0.0 declared | isolated npm lock SHA-512 |
| `uuid` | resolved by isolated lock | Vendor command identifiers | MIT declared | isolated npm lock SHA-512 |

`vendor-runtime/package-lock.json` is the authoritative transitive npm inventory for this slice. A
release job must convert the final packaged graph and native contents into the organization's signed
CycloneDX/SPDX artifact; this hand-maintained review input is not a substitute.

The provenance manifest records the exact package, source, patch, and platform-native hashes. The
preparation script retains verified input archives beside a receipt and the runtime verifier hashes
them and the extracted tree before module loading. `clinicalReleaseApproved` remains false.

The dated packaging-tool comparison is recorded in [`PACKAGER_AUDIT.md`](./PACKAGER_AUDIT.md).
The selected assembler is not authorized to sign, notarize, publish, update, or distribute. Recall's
stale `osx-sign` fork is not in the lock; nested signing remains a separate release-gated work item.
The official Electron 43.4.1 macOS Apple Silicon and Windows x64 archive filenames and SHA-256
digests are pinned in `release/package-policy.json`; the assembly script has no download path.
Packager's macOS Framework digest/re-sign default is explicitly disabled and recorded in that policy.
Its official signing/notarization libraries remain transitive dependencies but receive no activation
options; the Recall signing fork is absent.
The seven common production dependency trees and prepared Apple Silicon Recall tree also have
checked-in content hashes; the Windows Recall tree is still `UNCONFIGURED`.

The dated macOS input inspection and its non-distribution signature findings are recorded in
[`NATIVE_ARTIFACT_AUDIT.md`](./NATIVE_ARTIFACT_AUDIT.md). The upstream executable/top-level dylibs
are ad-hoc signed and the GStreamer framework is unsigned; every nested Mach-O must be signed by the
CosmaNeura release identity before notarization and distribution.
