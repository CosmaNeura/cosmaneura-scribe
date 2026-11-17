# Mac Store distribution helper admission

Tier 2. Owner: Scribe release operator. This source fix changes no services,
credentials, consent, capture grants, cohorts or installed application.

The submitted Mac122 private bridge and Apple's TestFlight-installed bridge have
the same executable sections and complete pre-signature bytes, except for
`LC_CODE_SIGNATURE.datasize` and `__LINKEDIT.filesize`. Apple changes the signature
blob and those lengths. The packaged whole-file hash therefore refuses the
legitimate installed helper before it can start.

The fixed MAS bridge declares `hashAlgorithm: macho-store-v1` explicitly in each
of its three identical role declarations. Its digest includes all bytes before
the final bounded signature with only those two validated length fields zeroed.
The command's signature offset and every other load-command/code byte stay
bound. Thin 64-bit arm64/x86_64 Mach-O, section and embedded signature boundaries
are checked; unknown/fat images and inconsistent extents fail closed. No raw-hash
fallback exists for this Store declaration. Direct helpers keep their existing
whole-file hash and exact two-field declaration.

The running MAS executable/path check, no-follow file admission, permissions,
stable inode/size/mtime bookends and all native macOS signature/Team-ID/sandbox/
App-Group/audit-token/peer requirements remain in force. This digest does not
replace those native requirements or accept an untrusted executable's identity.

Package from the merged repair with the current provider/Store host builders.
Run `node scripts/hash-mac-store-bridge.mjs /absolute/signed/StoreBridge` after
signing the actual bridge, then use its exact declaration for auth/audio/
presentation. Production's profile projector accepts only three coherent Store
declarations; direct declarations remain unchanged. Record the digest in the
new package receipt, seal the parent last with the existing identity, and verify
the actual installed distribution before claiming operational Store readiness.
Do not mutate an already-installed TestFlight package or reuse Mac122 as proof.

Verification is limited to retained submitted/distributed bytes, intentional
code/load-command mutation and malformed-boundary witnesses, plus source
type/lint checks. No application, permission, recording or diagnostic is run by
these checks. Final native recording/Save and production readiness remain open.

Recovery: keep the prior package and this explicit algorithm unactivated until
the replacement package is verified. Withhold the new Apple build if admission
or source checks fail. Do not revert to bypassing helper verification; reverting
the source leaves Mac122's known startup refusal and does not repair it.
