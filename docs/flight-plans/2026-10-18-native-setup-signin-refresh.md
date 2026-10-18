# Native setup sign-in refresh

Tier 2: an additive native auth lifecycle seam across iOS and desktop. The
owner authorized startup optimization and this scoped implementation in the
current redesign. The base is merged PR349, ca11aadc752c670ae6713cc45bb54150508f3efa.
Existing signed releases 76/90 and their qualification evidence are retained.

After metadata discovery, a capable host can prepare a native-only token for
the current encounter. Actual configuration/foreground events and fresh
consent handoff refresh or join the same scoped owner. Legacy hosts retain the
post-mount behavior. There is no periodic renewal, returned token, SDK/cache
policy change, patient consent fabrication, admission or microphone activation.
ADR0078 records the contract and retained freshness/cancellation guards.

Validate the current mounted account/revision, opaque ownership, concurrent
coalescing, queued callback revocation, native cancel-before-prepare, current
mount replacement and original exact five/six-key admission eligibility.
Run the capture and desktop focused suites, types/lint, and the synthetic
Swift connection fixture; the latter uses fake auth/wire and consented
synthetic admission without accounts, Keychain, sockets or audio. Existing
SDK/native-recording module inputs are reused only after byte verification.
Actual Apple platform builds and qualification remain required before rollout.

The first token in the saved Mac89b trial took 1593ms, while later short-lived
tickets were reused. Its Record-to-ready interval was 6751–6905ms. These are
historical measurements; no latency saving is established by local fixtures.
The newer Mac90 trial also remains over five seconds. Moving token work alone
does not establish the target or explain the remaining receiver/native work.

Require independent review after the last substantive push and bind exact
merged sources to separately built native and renderer artifacts. Root owns
push, merge, qualification, rollout and physical tests. Recover by reverting
the new capability/hook implementation and rebuilding the prior reviewed
release; the ordinary fresh getter remains the fallback on a preparation miss.
No server migration, environment change, auth TTL increase, capture authority
change or stored-data rewrite is included.
