# Recorded Resume negotiation handoff

Risk: Tier 2, receiver-side credential handoff. Dark synthetic development only;
production activation is outside this change.

Desktop17's actual numeric journal shows initial Record at 3.631–3.632 seconds
and Resume at 5.955 seconds. The Resume continuation request occupied 2.447
seconds of its 2.497-second pre-source group. The independent OS probe overlapped
that request. Fresh source preparation then occupied another 2.241 seconds.
These measurements do not prove that all network time is Core execution.

The recorded-prefix continuation currently performs ordinary negotiation; its
immediately following fresh source performs another negotiation. The candidate
uses the existing Core preparation-context route for continuation, then transfers
that server-only context once to the immediately following source. No public
wire contract or native client action changes. This is not a measured performance
pass until the deployed receiver completes a native Resume under five seconds.

The source transfer requires the current Core source-start advertisement, a
strict positive continuation position, and a validated continuation receipt.
Lease ID, generation, receipt ID, expiry, first sequence, channel, unique object
IDs and contiguous bounded reservation geometry must match. A destructive take
keeps the existing account/session/revision/workspace/binding scope, original
30-second lifetime and less-than-25-second dispatch limit. It keeps fresh local
account checks, current Core authorization around both source decisions, owning
transport cleanup, cancellation and original native stop custody. Missing
context chooses the unchanged negotiation path before source I/O; dispatched
failures never retry, refill the context or fall back.

Pause does not renew or reserve anything. A person still chooses Resume after
the prior physical source and server owner have retired. Source preparation and
Start authorization remain fresh. No user/workload credential, authorization
decision, source grant, new permission, queue contents or transcript is cached.

Integration starts from the actual current merged receiver, not Desktop17's
older analysis tree. Overlay only the focused candidate delta, preserving the
merged PR490 production preparation and PR491 timing observer. The current Core
5033 source already accepts arbitrary valid source sequence positions and lease
generations on its ordinary source-start sequence and rechecks scope between its
prepare and authorize decisions; no Core deployment is required by this change.

Validate the scoped transport/custody tests, lint and changed-module types, then
publish independent final-head review before merge. Build the merged receiver
artifact and retain its exact runtime/source identity. Staging rollout must keep
all configuration, schema, leases, other workloads and original-owner custody
unchanged apart from its image/revision. Run one measured native Resume after
normal source retirement. Functional capture, acoustic playback and live Zoom
qualification remain distinct gates.

Recovery is the previously qualified receiver image
`sha256:f87abae5245c9f4d803d75379c7ccfc2c95676f70c460a5b3591b5960ea1f975`
under unchanged configuration. There is no schema migration or persistent cache
recovery; a receiver restart discards the bounded process-local handoff. An
uncertain native source remains under its original stop/recovery ownership and
must not be replaced by a new recording attempt.
