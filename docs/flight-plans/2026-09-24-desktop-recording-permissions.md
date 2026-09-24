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
Installation and actual prompt/capture outcomes remain pending. Independent
PR review remains distinct from the implementer's checks; no other task or agent
is contacted.
