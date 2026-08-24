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
publish, or update. Exact direct development dependencies `@electron/osx-sign@2.7.0` and
`@electron/notarize@3.1.1` belong only to the separately approved receipt-bound external macOS lane;
the checked-in assembly script cannot invoke them. It requires a separately hash-verified Electron
archive, builds an allowlisted temporary stage, and keeps Packager signing disabled;
`release/package-policy.json` records that boundary. Its 2026-08-24 development-assembly approval
first permitted a fixed-input unsigned Apple Silicon run. Fuse hardening and the external macOS
signing/notarization lane are now separately approved, but the signing lane remains fail-closed until
the Team ID, Developer ID identity, and Keychain notarization profile are configured. Capture,
clinical use, distribution, and deployment remain disabled or unapproved.
The options also disable Packager 20.3's default macOS Framework digest embedding because that path
modifies and ad-hoc re-signs the Electron Framework; final integrity and signing belong to the
external release lane.

The checked-in lock is supply-chain metadata, not permission to invoke the native SDK. Clinical or
PHI use remains disabled.
