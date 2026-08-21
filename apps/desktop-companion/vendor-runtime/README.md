# Isolated desktop runtime dependencies

This directory is intentionally not a root npm workspace. It isolates Electron and the Recall
Desktop SDK from the existing web/mobile install graph because both packages have install scripts.

Never run a normal `npm install` or `npm ci` here. The desktop packaging lane must first install this
exact lock with lifecycle scripts disabled, then run the repository preparation command. That command
verifies the registry package and native archive against
`../vendor/recall-desktop-sdk.provenance.json`, applies the reviewed logging/environment patch, and
only then makes the runtime eligible for packaging.

The checked-in lock is supply-chain metadata, not permission to invoke the native SDK. Clinical or
PHI use remains disabled.
