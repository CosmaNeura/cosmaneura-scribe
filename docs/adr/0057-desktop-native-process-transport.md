# ADR 0057 — Connect the native desktop audio helper to capture

Date: 2026-09-22

Status: local source/process integration; desktop application uninstalled

## Provider outcome and decision

The macOS microphone/system producer now has an executable boundary consumed by
the desktop PCM/WAV capture adapter. `NativeProcessPCMDriver` owns a dedicated
`ScribeDesktopAudioHelper` child. This closes the transport gap between ADRs 0055
and 0056. Durable main-process stores, provider UI/authority composition and
installed acceptance remain necessary before a provider can use it.

The main-process owner supplies a fixed absolute helper path and SHA-256 from its
eventual release receipt, observed workstation state, and fresh selected-window
authority under the existing capability/consent/lease/indicator controller. The
driver is disabled unless explicitly enabled by that owner. It checks a regular,
executable, non-symlink artifact, bounds the file size and verifies its hash and
file identity before spawning. This is not code-signing or hostile filesystem
race acceptance; signed immutable application packaging remains a release gate.

Only exact Chrome/Zoom bundle, PID/window IDs, Core-derived capture limits and
fixed control messages enter inherited stdin. The helper receives no credential,
URL, window title, arbitrary command, shell or inherited environment. Read-only
availability is a separate mode. No-argument invocation cannot start capture.
The actual capture mode still requires deliberate trusted-host activation and
the existing native permission/source checks. The new helper was not activated
against an operating-system audio source during this work.

## Delivery and lifetime

Frames use a four-byte big-endian length, one-byte kind and bounded body. Metadata
JSON is separate from PCM16LE bytes; it cannot carry audio strings. Native command
input is at most 2,048 bytes. A PCM frame carries an exact sequential sample offset
and at most 4,096 samples. Node's decoder uses one fixed 8,201-byte buffer and
clears consumed/rejected input and copied audio after its receiver settles.
Swift's owned packet/write buffers clear after use or discard. Framework/kernel
copies are outside this memory-clearing claim.

Both native sources must start and establish common coverage before `ready`.
The existing adapter retains that coverage before sending `activate`. Native
retention is limited to four packets; only one packet can await acknowledgement.
Acknowledgement follows the main-process receiver, including encrypted
persistence whenever a full WAV chunk is emitted. A partial WAV chunk stays in
the existing bounded in-memory chunker; acknowledgement does not claim that
every individual PCM packet is already durable. Normal drain finishes the final
partial chunk; uncertain/discarded audio cannot become a successful final tail.

The session handle exists before asynchronous authorization or artifact reads.
Startup has a 15-second deadline, including authorization, with cancellation
checked after each await to prevent late spawn. The host also enforces the
absolute authorized capture end. A failed stop retains the same child/session
for retry; discard can upgrade a pending drain. Stop responses are correlated,
bounded and validated. Successful return waits for the owned child to actually
exit and any in-flight consumer to settle. A caller timeout never proves stop
and never silently restarts a source.

The child receives a heartbeat every five seconds. EOF, malformed input, failed
output or more than 15 seconds without parent input starts discard. After parent
loss the dedicated executable exits even if native stop has not returned within
another 15 seconds. Corrupt transport is closed; no stop receipt is trusted from
it. The existing controller must still retain its failure indicator/lease until
closure/reconciliation is confirmed, and own its reviewed emergency path. This
transport does not replace that authority or the operating-system lifetime gate.

## Verification and limits

Tier 2: native lifetime and capture custody. Continue the authorized local,
invented-data flight plan in ADRs 0054–0056. No dependency, auth/consent rule,
service, environment, Keychain, Core/OS source, installed app or release changed.
Recovery is to leave this source unmounted and its helper unused.

Evidence lives at
`/Users/jw/Desktop/Cosmas/scribe-desktop-native-pipe-20260922.eMXizG/`.
The native package and production helper compile with Swift 6, warnings as errors,
and a macOS 14.2 target. All 26 native checks and 52 desktop checks pass. Both
affected TypeScript workspaces typecheck; affected lint and the standalone Node
driver bundle build pass. Native checks cover strict commands, truncated/oversized
input, bounded packet retention/acknowledgement and existing audio/mixer behavior.

`scripts/desktop-native/pipe-fixture.swift` is a separate executable built from
the actual library sources, with an explicit invented-consent source. It is not
a product target, native permission probe or synthetic mode in the shipped
helper. Desktop checks bind its exact hash and exercise actual Swift ↔ Node
pipes, readiness/activation, backpressure, exact mixed samples/final WAV,
failed-stop retry, drain/discard concurrency, cancellation, artifact rejection,
startup deadline and forced process exit after uncooperative parent-loss cleanup.
The existing encrypted capture/HTTP recovery fixture also passes. Its stores,
backend and generated audio remain fixtures, not operating-system storage,
live Core or physical fidelity evidence. Initial compiler failures and their
corrected runs are retained in the evidence directory.

Next compose durable creator-scoped main-process storage and the existing
provider controls, including actual startup and incomplete-coverage display.
Native selection/permission/indicator UI, actual Meet/Zoom capture extent,
physical interruption/recovery, Windows support, complete Core runtime, both
standalone app packages and signed operating acceptance remain open. W13,
Mac R2 and their accepted session trials remain unchanged.

## Continuous-window amendment — 2026-09-27

The configured desktop flow now opts into the receiver's private capture-v3
protocol. It retains the original process and source while Core renews short
capture windows. The existing PCM chunker grows only within a fixed initial
budget and keeps its partially filled buffer and sequence. All receiving layers
stage the verified allowance before awaiting native acknowledgement, because
renewed audio can arrive before the acknowledgement. Duplicate extensions do not
refresh deadlines; Stop rejects pending extension and prevents late reactivation.

Durable continuous renewal uses flow record version 5, with the old deadline
retained until replacement reservations arrive. Versions 2–4 remain readable;
older clients fail closed on version 5. The same encryption, queue and upload
protocol remain in use. The [renewal flight plan](../flight-plans/2026-09-27-desktop-recording-renewal.md)
records recovery and release constraints. Generated-volume and native-pipe tests
verify the software composition; installed Zoom/Chrome audio remains a separate
acceptance result.
