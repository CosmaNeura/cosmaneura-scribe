# Owned native network fault preparation

Risk: Tier 2, because this adds an explicitly selected network path to a native
transport. The work is dormant until a separately reviewed lab build is made
and installed on an owned target. It does not activate faults or qualify the
current iOS14 or Desktop8 candidates.

## Scope and owner

The virtual lab task owns the instrumented build, a single synthetic run, its
loopback listeners and cleanup. The ordinary build has no lab-network branch.
An instrumented build must define `SCRIBE_VIRTUAL_LAB_NETWORK` and include
`ScribeVirtualLabNetwork.json` in its signed bundle inventory. There is no
renderer, environment-variable, process-argument or user-default switch.
The resource binds one canonical run UUID, issued/expiry UTC seconds (at most
one hour), and one loopback port. Missing, unknown, malformed, future or expired
configuration refuses the instrumented transport. A continuous-clock deadline
captured at construction prevents a wall-clock rollback from extending that
instance's original allowance. The ordinary private pinned
TLS profile is unavailable in this flavor; only the existing exact staging
provider HTTPS origin is accepted.

All three existing ProviderNativeTransport timeout pools use Apple's public
HTTP CONNECT proxy API, with direct failover disabled and no matching/excluded
domain exceptions. The destination URL, hostname, TLS validation, redirect
refusal, token handling, idempotency headers, route budgets and native capture
authority are unchanged. The proxy relays encrypted TLS bytes. It is not a TLS
terminator, certificate authority or request-body observer. Clerk, W13, Core
browser and other processes do not inherit this per-session setting.

## Evidence required before activation

A later operator must verify the actual owned host/target, whole signed bundle
including the resource, source revision, compiler definition and build number,
then bind these to a new immutable scenario. A fresh full app-data backup and
idle/closed native proof precede any replacement. Existing failed runs and all
saved/encrypted data remain preserved.

The separate relay must listen only on the declared 127.0.0.1 endpoint and allow
CONNECT only to the exact staging receiver host on port443. Its process and
listener identity, bounded lifetime, resource limits and TLS passthrough tests
need independent review. Toxiproxy may then sit between the client and relay to
apply a declared stream latency or reset. TCP stream reset is not IP packet
loss. No global proxy, DNS, firewall, trust, certificate, system clock or
physical-host setting may be changed.

Offline URLProtocol checks prove configuration and unchanged transport
contracts only: they intercept before DNS/TLS and never connect to the proxy.
They do not prove an actual simulator's URLSession proxy routing, TLS server
validation over the relay, network-fault behavior or recovery. Those require a
separate normal synthetic capture with real consent, actual native input proof,
first-packet/upload/stop observations, preserved note/audio, and a backend
cohort fixed for the run. Failure must stay failed; no observation may be
manufactured from expected fixture contents.

## Recovery

Stop nonzero sources through their owned coordinator; request normal native
stop/Finish once when safe and observe actual physical and backend source-stop
proof. Network silence or listener absence is not a stopped-recorder receipt.
Remove only owned fault rules and listeners after their process/identity checks.
An expired resource refuses new transport requests and does not cancel a
request already issued or extend any capture authority. Retain uncertainty and
encrypted queues if stop/upload cannot be confirmed. Replacing the instrumented
client with the already verified ordinary candidate requires preserved app data
and actual idle/closed proof; it is not an automatic rollback.

No API/worker/Core deployment, database/schema change, new dependency, purchase,
production activation or PHI-bearing traffic is part of this preparation.

## Relay implementation

The separate Tier2 relay is documented in
[`tools/virtual-lab/network/README.md`](../../tools/virtual-lab/network/README.md).
Its CLI verifies the physical owned Mac and publishes a private exclusive port
guard before binding. It passes only opaque TLS to the fixed staging authority,
bounds parsing/sockets/bytes/lifetime, and preserves failures without automatic
guard recovery. Actual local TLS tests use a disposable certificate with normal
hostname verification; no system trust is changed. No instrumented-client or
Toxiproxy activation accompanies this source change. Recovery and clinical
acceptance remain the separate normal-flow gates above.
