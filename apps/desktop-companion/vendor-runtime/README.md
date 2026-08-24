# Isolated desktop runtime dependencies

This directory is intentionally not a root npm workspace. It isolates Electron, the Recall Desktop
SDK, the fuse utility, and the unsigned application assembler from the existing web/mobile graph.
The Recall package retains the lock's only lifecycle script; Packager has none, but its runtime API
can acquire Electron archives and invoke signing tools unless the caller prevents both.

Never run a normal `npm install` or `npm ci` here. The desktop packaging lane must first install this
exact lock with lifecycle scripts disabled, then run the repository preparation command. That command
verifies the registry package and native archive against
`../vendor/recall-desktop-sdk.provenance.json`, applies the reviewed logging/environment patch, and
only then makes the runtime eligible for packaging.

`@electron/packager` is pinned for assembly only. It must not download Electron, sign, notarize,
publish, or update. Any future packaging script must require a separately hash-verified Electron
archive and must keep Packager signing disabled; `release/package-policy.json` records that boundary.

The checked-in lock is supply-chain metadata, not permission to invoke the native SDK. Clinical or
PHI use remains disabled.
