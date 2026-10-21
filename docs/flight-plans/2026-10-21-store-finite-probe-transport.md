# Store finite-probe transport — Tier 2

The Store117 normal access check reached finite-probe spawn, then Bridge reason
5 / exit78 before availability metadata. The scoped numeric journal records a
16.22ms false permission result; it does not establish a TCC decision.
Observation receipt: `3f11a4410f376c391fd5900ad82860d5667ca2dfe4ed741e53625e6743d7482d`.
Numeric journal receipt: `98485aeca063e4134275da164cee894941361e889dc4f759812182349a591c54`.

The unchanged native `channel()` requires a connected AF_UNIX peer before
`scribe_store_open_message` accepts the descriptors. An independent test of the
exact channel/pair code admitted five open-input trials and rejected all five
immediate-EOF trials (`getpeername` returned EINVAL). Reproduction receipt:
`464db8e9c5bb9dcb5ec9d237412f2131e4497622205af3a97232320e24422fe9`.
This supports the transport correction without claiming an XPC or permission
qualification result.

This successor starts from the clean Store release source75d. Finite availability
and permission probes keep stdin open only for MAS plus the exact packaged
`ScribeStorePipeBridge` basename. Native child exit closes the pipe. Direct probes
still end stdin immediately. Native channel, parent lease, signature, consent,
capture, metadata, cancellation and 15s/120s deadline gates remain unchanged.
No Store117 diagnostic additions enter this source.

Local qualification uses pure mocked-child admission and result tests, plus the
existing finite-probe/framing tests, types and lint. The native reproduction is
retained separately. Independent source review must precede artifact production.
Final acceptance requires the normal Store recording-access check, an authorized
synthetic recording with confirmed Stop/save/review, and the existing signed
artifact checks. Offline tests do not establish those results.

Recovery restores the prior clean source75d Host artifacts through the retained
release procedure. It preserves installed app data, credentials, recordings,
permission state and private directory custody. No native gate or permission
reset forms part of recovery.
