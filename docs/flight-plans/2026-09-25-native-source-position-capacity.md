# Native source position capacity

Risk: Tier 2 because this validates native capture authority. This increment
aligns its total position ceiling with the already merged 2,048-position
capture protocol. It does not grant longer recording authority.

The old 360-position ceiling could reject a three-hour native run even when
each renewal was otherwise valid. The native source now accepts a hard ceiling
up to 2,048 positions. Initial and renewed windows still require a deadline at
most 905 seconds ahead, the same live run, the next generation, and a cumulative
allowance no greater than that ceiling. Wall-clock rollback cannot extend a
window past its monotonic deadline. Stop cannot be renewed.

Reuse: existing source window, streaming resampler, accumulator, frame admission,
acknowledgement and zeroization. No dependency, schema, key, file format or
renderer API changes. iPhone beta still reports renewableAuthority:false and
rejects renderer extension. Foreground and heartbeat gates remain in force.

Validation streams 172.8 million invented mono frames through the actual Swift
core into 1,080 contiguous ten-second packets, 345,600,000 PCM bytes. A synthetic
clock advances three hours with 13 short-window renewals. The sink counts and
checks each packet without retaining the visit; no microphone, network or
installed application storage is used. Boundary tests reject excessive total
positions, a three-hour token, different runs, skipped/stale generations,
shrinking allowance, expired authority and clock rollback. Existing native
input/route tests also run.

This is a component capacity result, not physical three-hour acceptance or a
claim that automatic renewal/background capture is integrated. Native verified
renewal and encrypted persistence must be completed before enabling them.

Recovery: restore the prior client artifact. Existing encrypted recordings and
queues are unchanged and must be retained. No deployment or installation is
part of this PR; no migration or data rollback is needed.
