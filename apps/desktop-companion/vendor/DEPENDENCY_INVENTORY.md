# Desktop companion dependency inventory

Status: review input only; not a signed release SBOM and not approved for PHI.

| Component | Version | Role | License status | Integrity source |
| --- | --- | --- | --- | --- |
| Electron | 43.4.1 | Desktop shell (development/runtime tooling) | MIT declared | isolated npm lock SHA-512 |
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
