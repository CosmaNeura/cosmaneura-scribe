# ADR 0021: Receipt-bound external macOS signing lane

**Status:** Accepted

## Context

The development-only Electron assembler intentionally performs no signing. The packaged Recall
runtime contains an executable, dylibs, and a GStreamer framework that must be signed inside-out
before the outer application is sealed. Recall's public signing fork is not accepted, and mutating
the retained unsigned package in place would destroy the evidence used to authorize the next step.

Apple signing and notarization credentials must not enter source, environment files, build logs, or
command-line secret arguments. Capture, clinical use, publication, distribution, and deployment are
separate gates.

## Decision

Fuse hardening and macOS signing/notarization are two copy-on-write, receipt-bound operations.
Hardening consumes the exact unsigned assembly receipt, rehashes the input package, copies it to a
new output root, applies all nine Electron 43 fuses with exact `@electron/fuses@2.1.3`, verifies the
embedded ASAR header hash, and emits
a non-distribution hardening receipt.

The external signing lane uses exact registry releases `@electron/osx-sign@2.7.0` and
`@electron/notarize@3.1.1`; Packager's signing integration and Recall's fork remain prohibited. It
rehashes the hardening receipt, copies to another new output root, signs discovered code inside-out,
applies empty entitlements to Recall native code, signs the outer app last with hardened runtime and
a secure timestamp, notarizes with a named Keychain profile, staples the ticket, and runs the
checked-in signature, Gatekeeper, ASAR, fuse, and staple verifier.

Only the two hash-pinned Recall provenance archives are excluded when the signer misclassifies them
as binary code. A temporary Keychain path, Developer ID certificate SHA-1, and notarization profile
name are explicit non-secret inputs. Certificate and notarization secrets remain in macOS Keychain.
The lane refuses to start while the expected Apple Team ID is `UNCONFIGURED`.

## Consequences

- The retained unsigned and hardened inputs remain unchanged and independently auditable.
- A partial operation leaves an incomplete marker and cannot be mistaken for a finished artifact.
- A successfully signed and notarized artifact still records `distributionAllowed: false`.
- The first real signing run waits for a Developer ID Application certificate, the exact Team ID,
  a Keychain notarization profile, and a separately prepared release runner.

## Related

- ADR 0020
- `apps/desktop-companion/release/package-policy.json`
- `apps/desktop-companion/vendor/PACKAGER_AUDIT.md`
