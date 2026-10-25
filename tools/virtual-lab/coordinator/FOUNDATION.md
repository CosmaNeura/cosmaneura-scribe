# Coordinator ownership and recovery contract

This library supplies the journal, bounded journey engine, target lease and
explicit recovery operation. Product adapters and the command-line entry point
are separate integration layers. Passing its mock tests does not qualify native
capture, authentication, transcription, saved audio or dashboard behavior.

Run the library regressions with Node 24 and an existing Python 3 runtime:

```sh
node --test tools/virtual-lab/coordinator/engine.test.mjs \
  tools/virtual-lab/coordinator/guard.test.mjs \
  tools/virtual-lab/coordinator/recovery.test.mjs \
  tools/virtual-lab/coordinator/tool-identity.test.mjs
```

`runJourney({scenario, adapter, output, labRoot, signal})` records each pending
action before invoking the adapter. Observed results are private, immutable
files bound by hashes in an ordered journal. Resume validates the entire event
chain and asks the adapter to reconcile a pending action from actual state. It
does not repeat an ambiguous Create, Record, Finish or Save.

The journal binds scenario, source/build identity and the exact maintained lab
runtime inventory. Changing a runtime module blocks same-run recovery. Preserve
the original reviewed tooling and evidence directory for an unfinished run;
start a new run after changing them. Documentation, tests and modification times
do not change the runtime digest.

Target ownership is shared across all lab/output roots for the current OS user.
The adapter must derive a stable fingerprint from actual device identity. A
complete, fsynced guard is published with atomic no-replace semantics; an
existing empty or unrecognized guard is never overwritten. Complete lease and
successor-claim files use atomic no-replace publication too. Darwin and Linux
are supported; unavailable atomic rename facilities fail closed.
The initial journal is durably published before the target lease, so a crash
immediately after acquiring the target still leaves a recoverable run identity.

An interrupted run requires explicit `recoverRun`. Its scenario, tool digest,
canonical output and target fingerprint must match. A guard can be claimed only
after each prior owner is confirmed dead on this host and its run identity
matches. Live, foreign, incomplete or uncertain ownership blocks recovery.

The adapter's `recoveryInspect({scenario,state,observations,output,signal})`
must acquire fresh control handles and inspect current native state and owned
participant resources. Historical process, tab and session IDs are evidence,
not authority to command them. `recoveryCleanup` closes only those fresh control
handles. No recovery callback may silently issue Finish or restart the app.

Cleanup distinguishes resource settlement from capture settlement. After Record
has been attempted, release requires a fresh native stop proof for the exact
admitted visit/session, no pending native mutations and a non-regressing native
revision. A completed live journey also needs its matching recorded Finish.
An uncertain capture retains the target lease and its observer evidence.
Before any Record attempt, recovery may instead prove that no capture was
started by this run. The validated journal must contain no Record or later
action, and a fresh passive inspection must explicitly report each observer's
absence or its exact implementation identity and zero pending replies. An
observed visit must match the journal. An unexpectedly active capture still
retains the lease. This early recovery path makes no claim that it stopped audio.

Timed-out work remains tracked. Cleanup cancels and drains it, then confirms
resource state again; unresolved late work retains ownership. Resume passes an
opaque, one-use lease to the engine in the same process, without an ownership
gap. Recovery receipts preserve each attempt and never overwrite the journal.

Provisional performance budgets are fixed before measurements: cold launch
10 seconds, warm launch 3 seconds, workspace 10 seconds, preparation 15 seconds
and Record readiness 3 seconds. These are engineering goals, not user-agreed
SLAs. UI/tool durations and actual native readiness remain separate evidence.

Recovery from a library change is to stop creating new runs and restore the
exact prior reviewed tooling for unfinished runs. Keep all receipts and any
uncertain native app alive. Do not delete a lock, kill an app, change host audio
or disable host security to make a blocked recovery pass.
