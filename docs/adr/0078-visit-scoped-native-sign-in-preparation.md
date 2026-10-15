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
