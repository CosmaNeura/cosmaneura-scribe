# Electron packaging toolchain audit

Audit date: 2026-08-23

Status: **`@electron/packager` selected for unsigned assembly only; packaging and signing remain
disabled.**

## Exact candidate comparison

Both candidates were resolved into isolated temporary npm locks with lifecycle scripts disabled and
audited using the repository-pinned Node 24.19.0 and npm 11.5.2. No candidate was added to a runnable
application or allowed to build, sign, notarize, publish, or update an artifact during evaluation.

| Candidate | Exact version/integrity | Resolved graph | Lifecycle scripts | npm audit |
| --- | --- | ---: | --- | --- |
| `@electron/packager` | 20.3.0 / `sha512-3Mvg...fP5g==` | 48 dependencies | none | 0 vulnerabilities |
| `electron-builder` | 26.15.3 / `sha512-a1KM...8fJxA==` | 277 dependencies, including 22 optional and 13 peer | `electron-winstaller@5.4.0` | 0 vulnerabilities |

All 48 packages in the selected Packager graph declared a license in the generated lock. Its exact
registry integrity is recorded in `release/package-policy.json`, and the policy verifier rejects
missing integrity, non-registry resolution, new lifecycle scripts, a version mismatch, or signing
being enabled.

An npm vulnerability report is point-in-time evidence, not a security or release approval. The
smaller graph and absence of install scripts materially reduce review surface; they do not make the
assembler trusted to sign or publish.

## Recall signing-fork disposition

Recall's current publishing guidance recommends its `recallai/osx-sign` fork for signing the Desktop
SDK. The public fork was inspected but is not accepted into this lock:

- head commit `9b910bd88e4bbac5fc492653aad9932aab777493` is dated 2024-11-14 and is not verified;
- the fork is eight commits ahead and 94 commits behind current `electron/osx-sign`;
- its package version is `0.0.0-development` and it runs a build in `prepare`;
- installing it would introduce a GitHub source dependency without registry integrity.

`@electron/packager` must therefore run with its signing integration disabled. A separate,
deterministic signing lane must sign every nested Recall executable, dylib, and framework in the
reviewed order, sign the Electron application last, notarize and staple it, and then pass
`verify-signed-desktop-artifacts.mjs`. That lane requires its own dependency/code review and release
approval.

## Decision and remaining gates

Pin `@electron/packager` 20.3.0 as an isolated development dependency for application assembly only.
Do not add Electron Forge, electron-builder, the Recall signing fork, an installer, updater, signing
credential, or publishing integration in this decision.

Before the first assembly run:

1. implement a fixed-input packaging script that consumes only a separately hash-verified Electron
   archive and a reviewed staging tree;
2. prove the ASAR contains only compiled application code and that the Recall native tree is unpacked
   only at its fixed runtime path;
3. keep `packagingEnabled`, `captureEnabled`, and `clinicalReleaseApproved` false until a separate
   review changes them;
4. implement and review the external macOS/Windows signing lanes and installer choices;
5. rerun the lock, license, vulnerability, native-content, fuse, signature, and no-PHI gates.
