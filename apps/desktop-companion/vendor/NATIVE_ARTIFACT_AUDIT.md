# Recall 2.0.28 macOS native artifact audit

Audit date: 2026-08-23

Status: **Verified development input; no-go for distribution, PHI, or execution without a separate
native-acceptance approval.**

## Inputs and integrity

| Input | Pinned SHA-256 | Result |
| --- | --- | --- |
| `@recallai/desktop-sdk` 2.0.28 registry archive | `3c427d51dae415941ec6469cc44e244d2c1d23e9a2a0cad92d6cccb04055d0de` | exact match |
| Recall commit | `62bf3a1f8995af470272b2198f39f2f53c150fdc` | exact package metadata match |
| `desktop_sdk_macos.tar` | `1636d46c83eb2394d6ad643aaaa59731f3f0ad39b9532d8ebeea4b3805fd44de` | exact match |

The guarded preparation process inspected every archive entry before extraction. Recall's tar begins
with one metadata-only `./` directory entry. The guard now ignores only that exact link-free
directory record; the path normalizer still rejects `.`/`./` as a file, link, or normalized runtime
path. POSIX/Windows absolute paths, drive-qualified paths, traversal, escaping symlinks, unexpected
roots, and unsupported entry types remain rejected.

The preparation receipt records matching archive and extracted-tree hashes:

- native archive tree: `e8abcfaff4306bb1de930cf18487898abacd544317435c1c9579f3dd748d511b`
- extracted native tree: `e8abcfaff4306bb1de930cf18487898abacd544317435c1c9579f3dd748d511b`
- reviewed patched wrapper hashes match the provenance manifest

The independent runtime verifier rehashed the retained registry/native archives, receipt, patched
source, and extracted native tree successfully while reporting `clinicalReleaseApproved: false`.
No Recall executable or module was loaded by preparation or verification.

## Static macOS inspection

The main executable, `liblibbot_desktop_rs.dylib`, and `libui_recorder.dylib` are thin Apple Silicon
Mach-O files. `codesign --verify --strict` confirms their embedded ad-hoc signatures are internally
consistent, but `codesign --display --verbose=4` reports `Signature=adhoc` and no Team Identifier.
The bundled GStreamer framework is not signed. Gatekeeper does not accept the standalone native
executable as a distributable signed artifact.

This is acceptable only as a hash-pinned vendor input for controlled development. Before any signed
artifact can leave the release runner, the packaging lane must sign every nested executable,
framework, and dylib with the reviewed CosmaNeura Developer ID identity, apply the minimum approved
entitlements, sign the outer application last, notarize and staple it, and pass the checked-in
post-sign artifact verifier. The vendor's ad-hoc/unsigned state is not an exception.

## Next dynamic gate

A separate de-identified native-acceptance approval is required before loading the module or
launching the agent. That run must use no real appointment or patient data, obtain any upload token
only from the trusted backend path, and capture fixed-output evidence for initialize, permission
handling, meeting detection, start, stop, abort, shutdown, child-process termination, local-file
cleanup, and OS/native diagnostics. Product, clinical, packaging, and deployment gates remain off.
