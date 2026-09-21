# Scribe recovery after the abrupt stop — 2026-09-21

The existing Scribe checkout remained clean at `622648a`, with provider workflow
implementation `abea802b0d3c66e5945d74024ee1ecd5c3a8f899` intact. No branch,
worktree, Core source, auth policy or external service was changed during recovery.

The temporary W13 source/app directory, prepared presentation diagnostic and
local provider evidence directory are absent. Their prior results remain
historical checkpoint statements; their raw temporary logs, database and
scripts cannot be represented as retained or freshly verified. The cause of
their disappearance is not established. No historical database or live-service
trial was recreated. The old W13 Mac profile and diagnostic5 candidate are not
recoverable from those paths; no Keychain data was read, reset or migrated.

Durable recovered artifacts are in
`/Users/jw/Desktop/Cosmas/scribe-beta-recovery-20260921.weuh90ow/`:

- `retained-inputs/`: all 332 files from the saved W13 composition archive,
  individually checked against its original hashes before extraction.
- `native-source/`: recovered native coordinator, token policy, Keychain access
  guard and pinned ClerkKit 1.5.5, with a separate native diagnostic UI and fixed
  stage markers. This isolates browser presentation from the missing Electron
  parent. The coordinator's identity, cancellation and authorization rules stay
  unchanged. Diagnostic output excludes identity, credentials, URLs and bodies.
- `W13 Recovered Sign-In Diagnostic.app`: compiled Mac diagnostic, with a local
  ad hoc signature passing deep/strict verification. It is not a distribution
  build or a standalone provider app. It has no recorder or clinical API.
- `candidate-manifest.json`: source/package hashes and declared configuration.
  It uses the approved W13 development instance and desktop callback, with the
  archived base W13 `.clerk` and `.workspace-auth` Keychain namespaces. It is
  **not byte-identical to the lost diagnostic5 candidate** and does not access,
  reset or migrate that diagnostic profile.
- `native-tests.log`: 28 recovered native boundary checks pass without real
  sign-in. `build.log` records the native build.
- `provider-bundle/` and `provider-build.log`: the committed provider entry
  rebuilds with the retained Node 24/Vite runtime, without installing packages.
- `core-current-manifest.json`: read-only snapshot of the 82 dirty Core paths
  at detached `e21ba4c1fb1027de8123aca9b8aee25b8a11b612`. The absent earlier
  temporary baseline prevents a new byte-for-byte comparison against it.

The separately retained development iPhone IPA still matches SHA-256
`097754a4370de69921dd1f55f9b851cabaffbd85505f2ff44c7c9ec2cd78eaa8`.
This is file integrity, not a new device or release acceptance result.

## Next action and authority

Automatic approval review previously rejected launching the newly compiled
diagnostic because local software requires confirmation at launch time. No
specific launch approval has arrived. A new prompt identifies the recovered
candidate; it remains closed. Do not infer approval from a general resume, use
another launch mechanism, or inspect unrelated browser content.

After that exact approval, launch the diagnostic, inspect only its own state,
and use the fixed stage log to locate the hosted-browser failure. The owner
enters Tester credentials directly in the secure UI. Actual callback, strict
native identity/token binding, restart/logout custody, authenticated provider
host composition, phone-reachable approved backend and distribution acceptance
remain open. No SDK sign-in result alone establishes usable MCD beta access.
