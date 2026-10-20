# Store bootstrap failure diagnostics

Tier 2. Owner: Scribe founder. This is a diagnostic change for the independently
sandboxed Store candidate, using designated synthetic qualification only. It
does not authorize clinical use or change the direct distribution.

The signed Store99 candidate passed signature/entitlement checks and reached
the existing generic startup error dialog. The old Mach denial was absent;
that does not establish readiness. The broad main catch discarded its failing
stage, and the bare bridge's stderr was ignored. Neither an XPC namespace nor a
permission defect was established. This change makes the next failure observable
without changing runtime approval, path custody, source ownership or credentials.

The bootstrap catch emits a fixed numeric stage, then awaits a bounded append to
`store-bootstrap-diagnostics-v1.jsonl` before the unchanged error dialog and quit.
A rejected Store factory acquisition reports after its native cleanup and before
the rejection reaches the host's existing quit path. The outer catch shares the
same report promise, so it cannot append a duplicate failure. A composed host
regression verifies that the journal exists when the host calls quit.
The journal is enabled only after the existing private Store child checks pass;
earlier failures produce only the fixed stderr marker. There is no fallback data
path, chmod, repair or migration. Files must be private, owned, regular and singly
linked; the journal stops at 4096 bytes. No error messages, paths, identifiers,
credentials or payloads are accepted. The PID is numeric lifecycle metadata.
Nonblocking open refuses a FIFO before descriptor checks; a throwing diagnostic
observer cannot prevent native failure or exit completion. Focused regressions
cover both seams. The FIFO test creates only a disposable fixture with a bounded
local `mkfifo` command; it does not run an app or native service.

| Stage | Operation that failed or had not completed |
| --- | --- |
| 1 | Official MAS runtime guard |
| 2 | OS appData query |
| 3 | Existing private Store child validation |
| 4 | Set validated userData path |
| 5 | Existing Electron shell, single-instance, ready or renderer acquisition |
| 6 | Import packaged provider factory |
| 7 | Provider factory acquisition, including native session opening |
| 8 | Window/security binding and renderer loading after owner acquisition |

Only the source-selected MAS bridge receives a stderr pipe. The decoder accepts
the exact ASCII `SCRIBE_STORE_BRIDGE:1` through `:12` grammar, at most 1024 bytes
and 16 events, discarding every other string. First accepted bridge failure,
actual exit code (0–255) and fixed signal category (1 TERM, 2 KILL, 3 other) are
retained in the bootstrap journal and fixed stderr markers. The direct native
helper still receives ignored stderr. The argv, empty child environment, cwd,
frame parser, getState deadlines, disposal and stop/drain behavior are unchanged.

Bridge categories are: 1 compiled group absent; 2 argc invalid; 3 role or parent
PID invalid; 4 signed parent requirement refused; 5 descriptor/open message
refused; 6 server requirement construction; 7 connection construction; 8 peer
requirement setter; 9 other XPC error; 10 connection invalid; 11 peer code-signing
requirement error; 12 reply shape/type/range invalid. Existing bridge return and
exit codes and all valid service completion values remain unchanged. Diagnostics
do not constitute XPC admission or successful service lookup.

Qualification requires focused metadata privacy/path/decoder/client tests,
desktop types/lint, source review after the final substantive push, and exact
source-bound host/bridge production outputs. No compile or injected test proves
signed runtime behavior. Root separately signs a new candidate, reviews its
actual signatures and profiles, then dispatches one bounded normal startup.
Root's normal UI evidence, numeric stage and native category guide the next fix.
No identical startup retry, permission relaxation, identity change or auth reset
is authorized by this diagnostic change.

Recovery retains failed Store99 and its original receipts, uses existing direct
Desktop97 unchanged, and stops only the exact new candidate's owned process
group. New Store data and all original credentials/recordings remain where they
are. Store submission/runtime acceptance stays blocked until the normal signed
flow is independently qualified.
