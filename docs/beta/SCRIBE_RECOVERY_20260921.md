# Scribe recovery after the abrupt stop — 2026-09-21

Latest continuation: [W13 encounter connection repair](W13_ENCOUNTER_CONNECTION_REPAIR_20260921.md)
reproduces and corrects the disappearing access error and unbounded catalog read
in a prepared local web asset. The installed phone app is unchanged. Its
simulator-only API address and missing phone-reachable runtime still prevent
workspace acceptance; the bounded private HTTPS connection packet is proposed,
not activated. No new login or live-service trial was performed.

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

The owner subsequently reported a visible Keychain prompt, then confirmed it
closed after requiring their password at least half a dozen times. The owner
entered it in macOS; no credential was collected by the agent. This repeated
prompt experience is a recovery failure, not accepted provider onboarding.

A prompt-free inspector requested only references and access-control metadata
for the five exact W13 items, with password-data output pointers null. It made
no Keychain changes. Its first valid command output showed the unchanged R2
app path listed for decrypt access on four items. `cachedClientServerDate` did
not list R2. The later `w13-access-metadata-corrected.json` contains the fresh
all-five observation after the owner's final permission. The first
`w13-access-metadata.json` has invalid ACL status numbers
from an incorrect C return-type binding; **do not use that first file as evidence**.
The binding was corrected against the SDK header before the valid check.

Native app control closed the timed-out window and its following observation
showed a fresh R2 startup. This check also reached its safe timeout. The owner
then reported completing the remaining Keychain dialog. A fresh prompt-free
metadata check confirms R2 is now listed for decrypt access on **all five** items.

Reopening the exact unchanged R2 app passed its Keychain check in approximately
11 ms. The existing durable guard correctly restored `signOutPending`. Explicit
“Sign out / finish sign-out” completed and the actual window displayed “Signed
out. Ready for Tester sign-in.” Explicit sign-in then reached `hosted_url_ready`,
`anchor_requested` and `system_start_true`. The owner completed login in the
secure Cosmas/Clerk window. The fixed stage log then recorded `callback_received`,
`hosted_signin_completed`, `state_ready` and `native_signin_completed`. The actual
native window confirmed a session was present. The unchanged driver requires an
active, nonexpired session and the configured organization before returning ready.
No password, code, credential, callback URL or identity value was output.

The same R2 app was closed and reopened once more. Its Keychain check completed
in approximately 10 ms, and its actual window returned to the native signed-in
state without starting another hosted login. All 275 source/app manifest hashes
still match the approved R2 candidate. This establishes native callback and
signed-in-state restoration for this build. It does **not** establish strict
JWT claim/API acceptance, exact identity continuity across restart, token
refresh/revocation, or server logout of this new session. R2 remains signed in.

### Physical iPhone continuation

The exact iPhone UDID still resolves to Johns Phone, physical iPhone 12,
available/paired. A scoped installed-app query confirms
`com.cosmasos.synthetic.w13`, version 1.0/build 1. A sandboxed CoreDevice status
query timed out; the same read-only query outside the sandbox succeeded. These
are connection/package checks, not mobile authentication acceptance.

Device Hub's physical-phone Apps view exposes the existing W13 installation.
Initial Launch actions did not establish foreground success. The phone was then
observed at its passcode screen, and a read-only CoreDevice check confirmed
`passcodeRequired=true`. The owner unlocked it directly. A subsequent scoped
check returned `passcodeRequired=false`; no passcode was read or entered by the
agent.

The agent launched the existing W13 through Device Hub after unlock. Its actual
phone screen displayed the CosmasOS workspace welcome page and Sign out control,
and the owner independently confirmed it was open on screen. No phone app was
installed, replaced, reset or removed. The visible welcome state does not prove
a fresh Tester sign-in, exact native identity, JWT claims or API authorization.

One explicit “Choose an encounter” action showed Loading. The following
observations were back at the welcome page, with no encounter list or successful
API result established. No recording, consent mutation, clinical save or new
Speech/translation trial was started. The exact failure layer is unresolved;
do not label it a token or network failure without additional evidence.

The retained phone bundle still embeds `http://127.0.0.1:8046`. On the phone that
address does not reach the Mac. This remains a known configuration limitation,
independently of the unqualified native token/API path. The existing Core capture
facade requires Entra workload authentication plus trusted mount/interaction
context; a native user JWT cannot simply be sent to that facade as a substitute.
The approved authenticated host composition and a qualified phone-reachable
backend remain required. The original phone is left on W13's welcome screen.

Keep this exact approved R2 binary unchanged during the trial; a rebuild changes
its ad hoc code identity. No new R2 launch approval is needed. Do not clear
credentials or interpret a denied or stalled read as a signed-out session. The
20-second bound proved UI responsiveness, but was too short for the manual
multi-item permission sequence. Stable signing and acceptable authentication UX
remain release requirements; do not claim this diagnostic is a provider app.

The owner enters Tester credentials directly in the secure UI. Strict native
identity/token binding, refresh/logout/revocation custody, authenticated provider
host composition, phone-reachable approved backend and distribution acceptance
remain open. No SDK sign-in result alone establishes usable MCD beta access.
Latest owner-facing full desktop/mobile estimate is approximately 60%
(55–65% range), an engineering judgment rather than a measured completion score.
