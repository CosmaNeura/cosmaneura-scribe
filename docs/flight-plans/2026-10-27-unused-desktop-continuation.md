# First unused Desktop continuation startup

Tier 2. Owner: the Scribe staging owner. Initial cohort: the existing synthetic
Desktop staging profile. No production activation, data migration, consent
change, new grant, or new Core contract is included.

The October 27 Desktop run took 9.187 seconds from Record to native pending,
then 493.937 ms to native ready. The five-second acceptance target failed.
The retained provider OSLog attributes two consecutive requests: continuation
preparation took 4,247 ms (1,552 ms token, 2,688 ms receiver), followed by source
authorization at 4,090 ms (1,530 ms token, 2,554 ms receiver). Their receiver
timings include 1,005.088 and 1,021.686 ms of remote encounter lookup.

The existing shortcut covers a fresh admission's first generation and thirty
reservations. After unused preparation expires, normal Start instead requests
generation two and ninety reservations. That path previously negotiated Core
context and minted SDK authentication again for both consecutive requests.

This change recognizes only a first unused continuation: zero prior sequence,
previous lease generation one, and an exact generation-two receipt. It obtains
a new Core preparation context, executes the unchanged ordinary continuation
operation, and may retain that credential once for the native-owned Desktop
source sequence. The context retains its original thirty-second lifetime;
source take is limited to twenty-five seconds. The native connection may hand
its freshly minted JWT to that same source decision once within the original
five seconds. Account, mounted encounter, session, revision, lease and clock
checks remain mandatory. Core still checks current consent and authority
around the ordinary continuation and both source decisions.

A smaller valid reservation budget remains a successful ordinary continuation
without a handoff. Recorded prefixes, other generations, missing/expired
handoffs, and iOS source requests use the existing path. A dispatched failure
never retries or falls back. Credentials remain process-local and never enter
the journal, renderer, diagnostics, or response. The duplicate Swift bridge
source stays identical; the new native behavior requires the existing Desktop
feature setting.

Deploy the reviewed receiver artifact before the reviewed Desktop artifact.
Both changes remain compatible with the prior counterpart. Verify exact source,
artifact and configuration identities before replacing staging. Then measure a
normal unused expired setup and a normal fresh setup, retain first-attempt
failure evidence, and finish the functional fixture even when latency fails.
Record-to-first usable audio must remain strictly below 5,000 ms for acceptance;
local component checks do not establish that live result. Native pending/ready,
first usable buffer, and visible Recording are separate measurements.

Recovery is the previous reviewed receiver and Desktop artifacts. There is no
persistent handoff state to migrate or delete. Preserve recordings and normal
product state when replacing a client; no account, keychain, data-container or
capture-history reset is part of recovery. Close this staging exception after
the first reviewed qualification or by November 3, 2026.
