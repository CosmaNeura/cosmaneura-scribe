# Desktop source startup sequence

Risk: Tier 2, existing native capture authorization orchestration. Owner scope:
faster native recording, reuse existing capture/Core components, preserve keys
and recordings, local validation and implementer review before merge.

After the provider presses Record and chooses a meeting window, the desktop
backend asks its native helper to prepare for that start. The helper reuses the
deployed `source-start-ready` receiver/Core sequence with the original distinct
prepare/authorize keys and request nonces. This replaces two native HTTP calls
with one; physical latency remains to be measured.

The helper validates both receipts and retains the short-lived decision only in
native memory. The initial pipe reply still contains only the source grant and
process fence. The existing `sourceAuthorize` call consumes that decision once,
checks current account/revision and expiry, and returns the existing protected
decision to the main process. Window selection, permission checks, encrypted
capture, the audio-helper process fence and persistent indicator are unchanged.

Before decision delivery, even an uncertain combined response cannot have started
physical audio. Preparation cleanup therefore uses the existing original-proof
stop route. Once decision delivery is requested, a lost reply requires the normal
physical stop barrier. Both paths keep the journal until a valid stop reply and
durable journal update. Restart remains stop-only; no issued start decision is
persisted. Cancellation, retirement, expiry or an ambiguous response cannot
refresh authorization or schedule another combined request.

Only the receiver's explicit unsupported-route 404 permits the older separate
prepare/authorize path. Denials, malformed replies, timeouts and cancellation do
not fall back. The legacy preparation RPC remains unchanged for existing callers.

Validation uses the actual native source owner/registry/journal and session
validation with synthetic SDK, wire and storage; desktop controller/window-order
regressions; the existing invented-PCM pipe/renewal/crash suite; and a complete
Mac native-helper build. Exact source hashes, commands, results and implementer
review belong in the PR. These checks are not a physical capture or remote-call
acceptance claim.

Delivery requires a coherent Mac host/helper package after merge. Core537 and
Scribe197 are already deployed. No server update, dependency, schema, credential,
fixture write, iPhone update or production deployment is part of this change.
Recovery is a same-identity update to the retained prior coherent Mac package
after confirming the recorder is idle, preserving application data and keys.
