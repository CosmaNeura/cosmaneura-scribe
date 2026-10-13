# Fresh native source starts without repeated mount setup

Tier 2: cross-repository native source authorization and single-use credential
handoff. Owner: John. Both native desktop and mobile fresh starts are in scope;
general receivers, renewed leases, resumed recording and generic renderer
operations retain the existing route. No native audio, encryption, consent,
transcript, note, dependency, configuration or database schema changes are made.

The current virtual source baseline on merged Scribe PR 322 and mobile build 65
measured 1.231–1.292 seconds spent on repeated encounter lookup, token exchange
and mount resolution during source startup. Full source authorization took
2.815–3.950 seconds. The work removal target is that repeated setup batch;
physical first-audio timing remains required before the five-second goal is met.

Core PR 753 adds the closed `prepared_source` action to the authenticated native
capture receiver and advertises exactly one
`X-Cosmaneura-Prepared-Source-Start-Version: 1` mount header. Scribe takes the
original server-only mount context through admission and a validated initial
window, then uses it once for the unchanged source prepare/authorize sequence.
The context retains its original monotonic epoch, exact origin/account/session/
revision/workspace/binding scope, 64-entry capacity and 30-second eviction limit.
Source dispatch requires original age under 25 seconds, generation 1, sequence 0,
a matching returned session/lease/receipt/deadline and compatible channel.

The receiver preserves six fresh local identity/account snapshots; Core keeps
current Clerk, workload, visit, binding, consent, context-age and locked capture
authority checks around the original source decisions. Original owner proof,
distinct idempotency keys, request nonces and native stop custody are unchanged.
No key, source grant or access decision is cached. Missing/unsupported/expired
context and valid resume choose compatibility before source I/O. Once the one
Core source request is dispatched, malformed replies, cancellation, revocation
and lost replies fail without fallback, retry or credential retention.

Release order: hold the Scribe change until Core's independently reviewed
receiver contract is merged; then independently review and merge this exact
Scribe commit. Core merged as `8333339cd30df6efbb2845024414860f5b5451c6`.
Reconcile immutable Core/Scribe source and image digests before using the
existing approved staging controller. GitHub Actions stays disabled. No production
or new beta recipient promotion is part of this change. Installed native builds
can use the receiver-only improvement without a new app binary. Unsupported
Core remains compatible; the capability header is a contract negotiation, not a
user-visible feature switch.

Acceptance: transport tests cover desktop/mobile composition, original epoch,
strict capability version, one Core call, six current fences, foreign scope,
malformed receipts, cancellation, concurrency, compatibility and destructive
failure. The socket-only owned PostgreSQL fixture uses the frozen identity
verifier and current rows to check real endpoint startup without encounter
lookups and committed account revocation at each snapshot. Qualification captures
no microphone audio and invokes no speech/model service. Three fresh signed
native virtual runs must verify setup disappearance; repeat fresh fictional
recording → transcript → saved-note smoke tests and physical consent-to-first-
audio timing before declaring completion. Abort promotion if any authority,
scope, source custody or receipt invariant fails, or the full path regresses.

Recovery restores the preceding Scribe receiver digest first, then Core if
needed. The old route remains supported. Keep recordings, consent evidence,
transcripts and notes; no data reversal or irreversible cleanup is required.
Production promotion remains founder-only through the existing manual workflow.

Workspace evidence:
`output/scribe-provider-ux-20261007/startup-final-round-20261013/` contains the
numeric virtual baseline, source contract plan and local test reports. Record
independent review of the final substantive commit before any merge or release.
