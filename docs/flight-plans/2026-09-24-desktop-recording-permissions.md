# Explicit desktop recording permission setup — Tier 2

The installed Mac build 2 now opens the retained synthetic encounter and recovers
its original admission. Core attached the existing consent and created recording
session `f3534ee4-6015-4e6d-a04c-894941c70a19`; the admission is ready. Physical
capture remains unavailable because the helper only probes macOS permissions.
The existing button cannot request them, and the actual Microphone settings list
contains no Scribe entry.

The owner's continuing native/backend and physical-capture scope includes the
existing signed desktop identity and installation. This change completes its
permission setup without new identity, entitlement, dependency, cloud grant,
consent or capture authority. The user decides the normal macOS OS prompts;
there is no TCC database access/reset or programmatic grant.

## Change and preserved boundaries

- A deliberate **Set up recording access** action invokes a fixed new helper
  mode, `--request-permissions-v1`, through the main-owned, hash-verified path.
  It asks for microphone access only when undetermined, respects denial, then
  asks for screen/system-audio access. It emits only the existing availability
  boolean and exits. It cannot select a window, instantiate a recording source,
  create a stream, issue a lease or request a server start decision.
- Normal startup, refresh observations and capture start keep read-only
  availability checks. The setup command is invoked only by explicit permission
  refresh while the recorder reports permission-required.
- A pending setup is bounded to 120 seconds and cancelled on the owning signal.
  Only this non-recording process can be terminated by that path. Existing
  capture/stop deadlines and source-ownership cleanup remain unchanged.
- Start recording remains a separate action through current server consent,
  lease, deliberate meeting-window choice, indicator and start authorization.
  Permission setup preserves the existing recording preparation and request keys.

## Verification and recovery

Use a metadata-only executable fixture to distinguish read-only and explicit
setup modes, refuse disabled/locked/revoked/hash-mismatched execution and confirm
cancellation. Verify through the provider recorder that explicit setup does not
start recording or replace its prepared lease. Run applicable types/lint, build
the actual native helper, then exercise the normal installed macOS prompts.
Fixtures do not establish physical capture acceptance.

Package a new same-identity signed Mac update, retain build 2 and its custody
data, quit normally and install only after confirming no active source. Recovery
restores the prior signed application; it does not reset the provider's OS
permission choices or local journals. Revocation/denial continues to keep capture
unavailable. Preserve the already-created synthetic admission and session across
the update, including any required expired, unstarted-preparation recovery.

Evidence is retained under the task-owned
`runtime-recovery-20260924/permission-setup-20260924/` directory. The three focused
desktop test files passed 30 cases (13 unrelated physical-fixture cases skipped).
Capture and desktop types, final changed-file lint and the real Swift audio-helper
release build passed. The provider renderer and nine-artifact desktop host also
built. One test-only unsafe JSON return was fixed with an explicit unknown type;
the retained initial lint failure is superseded by `changed-lint-final.log`.
Build 3 was installed and reopened the retained synthetic encounter. Explicit
Resume renewed the unstarted preparation without replacement of the admission
or session. The setup attempt was followed by a normal application exit
(`0,0,0` in RunningBoard), with no observed OS prompt; the owner did not see the
attempt. A subsequent launch stayed alive but displayed Connecting your workspace
for several minutes. A process sample showed an idle main event loop rather than
a crashing or CPU-bound process. Prompt and physical capture acceptance remain
pending.

The follow-up adds a local, best-effort diagnostic trail with only a fixed list
of lifecycle event names, UTC timestamps and process IDs. It identifies native
connection stages and app/window/renderer shutdown reasons. It accepts no error
text, identities, endpoint/request values, credentials or capture content. Writes
use the existing app-owned data directory, private permissions and no-follow file
opening; limits are 128 events per launch and 64 KiB per file, with no truncation.
Diagnostics cannot block shutdown or alter capture authority. Rebuild the same
signed identity, preserve build 3, and recheck the installed workflow. A local
diagnostic fixture does not establish installed acceptance.
The two focused diagnostic/lifecycle test files pass all eight cases. Desktop
typechecking, changed-file lint and the nine-artifact host build pass. Renderer
and native helper inputs are unchanged, so their prior build evidence is reused.

Core staging changed during this observation to revision
`cosmaneura-staging-app--r1790259131a1-abe7631`, image digest
`sha256:66fb4aad8e2a554674a6d12416be81c664a9e1aaf1c45eed6028d0724b2308a2`.
Do not reuse an observer pinned to the older revision or infer that the deployment
caused the connection delay. No staging deployment was performed by this task.

Independent
PR review remains distinct from the implementer's checks; no other task or agent
is contacted.
