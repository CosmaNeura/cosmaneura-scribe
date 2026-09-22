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

The owner explicitly approved launching the recovered diagnostic. The attempted
launch started PID 10224 but its native UI did not respond. A one-second function
stack sample (no memory contents) shows the main thread waiting inside
`SecItemCopyMatching` while Clerk reads its existing device-token item. A cache
write also waits in Keychain on a background thread. This identifies the blocking
call, not the underlying reason macOS did not return. No Keychain prompt was
established by observation. No hosted sign-in or callback was reached.

After confirming its exact executable, only PID 10224 received SIGTERM. A later
scoped process check confirmed it absent. No other app or demo was stopped.
The original app, source archive, manifest and stack sample are preserved.

### Corrected startup candidate — R2

`W13 Recovered Sign-In Diagnostic R2.app` opens its window before a read-only
background check of five exact existing W13 startup Keychain items. A denied or
stalled read stops SDK initialization; a 20-second timeout keeps the window
responsive and rejects a late successful result. There are no new Keychain
writes, migrations, resets, credential output or authentication network calls
in the startup check. After a successful check, the original native coordinator
and SDK still perform their existing credential and session checks. This is a
startup correction, not proof that later SDK operations cannot block.

Hash comparison confirms every original auth/coordinator/vendor source file is
unchanged. Account configuration, bundle identifier and Keychain namespaces are
unchanged. Only diagnostic UI, its build target and new startup-check/test files
changed. Four focused startup checks and all 28 existing native checks pass.
The R2 app's local ad hoc signature passes deep/strict verification. These are
offline results, not native sign-in acceptance.

Additional durable evidence in the recovery directory:

- `initial-frozen-source.tar.gz`, SHA-256
  `8c263afdfa9a331c36b5aac6f05f1bfe9d310963644af6d8bdf33743a1636605`.
- `initial-frozen-candidate-manifest.json`, `startup-sample.txt` and
  `startup-sample-command.log` preserve the original failed attempt.
- `startup-r2-tests.log` records the initial test compilation error; the corrected
  `startup-r2-tests-fixed.log` records the passing build and checks.
- `startup-r2-change-review.json` records the exact changed paths and unchanged
  native authentication/configuration comparison.
- `startup-r2-manifest.json`, SHA-256
  `66f98625ebfcdbd4c03a9506a1a2de4d6d09ecff7df29eadb64e369e54488be0`,
  binds the corrected source and app.

Automatic approval review initially rejected the R2 launch because it considered
the rebuilt executable a materially changed candidate accessing existing
Keychain state and required fresh action-time confirmation. The owner then
explicitly answered **“Launch corrected W13 R2”**. Native app control launched
that exact candidate successfully; no launch workaround was used.

The actual R2 window was responsive during its Keychain check and after the
20-second timeout. Sign-in remained disabled and the SDK did not initialize.
A metadata-only system Keychain status check returned success, unlocked=true,
read_permission=true and write_permission=true; no credential values were read
by that status check. This does not prove item-specific authorization.

The owner subsequently reported that a Keychain prompt is visible. They were
asked to complete only the dialog naming W13, entering a password only in the
macOS dialog if requested. Confirmation that the dialog has closed is pending.
Keep this exact approved R2 binary unchanged while completing the prompt; a
rebuild changes its ad hoc code identity. After the dialog finishes, reopen the
same R2 candidate and verify its own UI. The timed-out process cannot accept a
late successful preflight or proceed to sign-in. Do not clear credentials or
interpret a denied or stalled read as a signed-out session.

The owner enters Tester credentials directly in the secure UI. Actual callback,
strict native identity/token binding, restart/logout custody, authenticated
provider host composition, phone-reachable approved backend and distribution
acceptance remain open. No SDK sign-in result alone establishes usable MCD beta
access. Latest owner-facing full desktop/mobile estimate is approximately 60%
(55–65% range), an engineering judgment rather than a measured completion score.
