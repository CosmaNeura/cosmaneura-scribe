# Retain authorized native audio at interruption

Tier 2: captured audio retention and authorization boundaries. Owner requested
reliability work with virtual synthetic tests. This change is prepared locally;
root review controls commit, release, install and staging delivery.

## Scope and authority

The native encrypted microphone graph opts into preserving its already admitted
PCM on ordinary route changes and interruptions. The legacy renderer PCM graph
keeps its existing discard behavior. Admission closes immediately and the one
admitted callback gets at most two seconds to settle. Timeout, malformed capture,
permission loss and media-service failure remain hard failures; no source resumes.

Drained partial persistence requires the original source/run, still-usable proof
journal, exclusive native gate, unchanged current account revision, and current
microphone permission. The check and locked write execute synchronously on the
MainActor, with no intervening await. Frames admitted before the enforced PCM
deadline may be saved after lease/short start-proof expiry while the original
custody and current account remain valid; this grants no fresh capture. A
heartbeat racing ordinary stop tests that same finalization guard before choosing
discard, and the actual write checks it again. Ordinary stop retirement prohibits capture
while allowing this final write. Auth retirement separately and permanently
revokes that ability and synchronously fences the sink, including already
admitted full packets. No grant, reservation, deadline or lease is extended.

The hard-event lock order is driver admission → sink → queue store. The native
invalidator only calls sink. Sink observers release the sink lock and schedule
actor work; they do not reenter the driver. The pending callback wait never holds
that lock, and a hard event or release wakes it immediately. Synchronous storage
I/O remains an existing unbounded dependency; the two-second bound covers the
admitted-callback wait, not arbitrary filesystem stalls.

## Completion and failure

A benign event closes the physical source before the retained partial is
committed exactly once. Duplicate notifications/stop calls cannot emit another
packet, overlap a source or reuse the consumed run. Known authorization denial
blocks uncommitted partial persistence; prior encrypted packets remain intact.

If final persistence fails or its authority is denied, a latched completion error
survives retries. Physical closure can still confirm the original Core stop;
that does not imply durable recording completion. The provider host blocks
sealing/upload and shows that the last part could not be saved, earlier saved
audio is retained, and the visit needs support. No automatic discard, replacement
visit, reset, new key or silent partial-success upload is introduced. Explicit
provider-reviewed partial recovery is a later product decision.

## Verification and release

Run actual native PCM/driver/continuation/queue code with injected synthetic audio,
nonpersistent wrapping keys and in-memory stores; test near-full tail, pending
callback, duplicate stop, permission/capture override, auth retirement, final
storage failure, physical-close retry and the existing three-hour stress cases.
Run actual provider source/run/host fixtures, iOS typechecks, native metadata/UI
adapter checks, lint and typecheck. Preserve failed attempts and exact source/log
hashes in the local handoff. Virtual timing excludes real device/microphone,
network, Keychain and disk performance. It does not prove the four-second physical
target or recover the previously excluded September 29 recording.

Release uses the existing native pipeline after root review and idle-device
confirmation. No server schema/API changes are needed. Rollback to the prior
binary preserves saved ciphertext and original source-stop journals; never
uninstall or clear retained state.
