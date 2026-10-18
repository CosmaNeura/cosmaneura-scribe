# 0078 — One native sign-in preparation per verified visit opening

Use the existing SDK to move one fresh-token wait ahead of Start, after current
mount confirmation. One native RAM task/ticket belongs to one verified mount and
auth revision. Only a newly minted ticket (under one second) is eligible, because
the downstream setup still needs most of the original five-second interval.
Transfer preserves original JWT, wall and monotonic expiry. No periodic polling,
renderer token, cache of server access decisions or silent sign-in is introduced.
Expiry/mismatch uses fresh authentication before dispatch; uncertainty after
dispatch never triggers another request. Speculative failure cannot impair the
idle workspace. Device recording performance requires separate qualification.
# Event-driven setup refresh (October 18, 2026)

Newly capable iOS and desktop hosts advertise version 1 of native sign-in
preparation. An already-authorized mounted encounter may request an opaque,
cancelable native preparation after metadata discovery becomes ready, after a
real configuration change, on foreground return, and at fresh consent handoff.
No timer renews it. These acknowledgements contain no token, patient authority,
consent, capture permission or source grant. Legacy hosts keep their existing
post-mount behavior; newly capable hosts avoid that redundant speculative mint.

Each setup owner coalesces a pending mint. Configuration changes, foreground
loss, encounter disposal, account/revision changes and canceled recording
actions fence the exact owner, including cancel-before-prepare and late replies.
Queued callbacks recheck the captured signal and current setup before acting.
Canceling an SDK caller retains the existing bounded pending-token cleanup;
cancellation-resistant SDK tasks can settle later under that existing guard.
This does not promise that only one underlying canceled SDK worker exists.

Admission destructively claims a ticket only for the original exact iOS
five-key or desktop six-key body with its existing native capability. The
original one-second reuse bound, five-second/JWT lifetime, wall/monotonic
agreement, account/mount/revision checks and pre-wire recheck remain unchanged.
A miss uses the ordinary fresh getter. Consent, encrypted persistence,
recording-window and final source/permission checks remain required. No audio
or admission starts from setup refresh. Physical latency savings require a
new measured trial; the observed first-token delay is a hypothesis for this
change, not its result.
