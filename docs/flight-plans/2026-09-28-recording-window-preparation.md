# Prepare the native recording window before the Record tap

Owner: MCD operational beta owner. Tier 2: timing of existing capture-lease and
reservation operations within the approved recording-readiness work.

The last physical build 42 trace spent 2.056 seconds on the lease and 2.828 on
reservations before source authorization and microphone activation. Build 43
reduces the first reservation batch to 30; its physical speed remains unmeasured.
This change starts the same metadata preparation after an authorized native
encounter opens and after a confirmed pause. The screen does not await it.

The native factory still requires the existing authenticated recording context.
Preparation uses the existing lease and reservation owners, including current
server consent/access checks and durable original intents. It creates no source
owner, stop proof, microphone graph or permission prompt. Start joins an in-flight
attempt, then rereads/revalidates the durable receipts through the same owners.
Near-expiry leases still renew; source preparation/authorization remains fresh
and occurs only after deliberate Start. No authority cache is added.

Each successful open/pause schedules one attempt, with no timer or retry loop.
Failure leaves the normal ready/paused screen usable. Deliberate Start may
recover the existing durable intent. Pause, close, seal and authentication
retirement cancel preparation. A replacement preparation waits for any prior
cancelled request to settle; Start, seal and close also join outstanding work
before accessing the same owners or releasing custody. Source stopping remains
the first operation. A late result cannot start audio or replace recordings/keys.

Validation uses the actual native host, owners, encryption and queue with
synthetic service/source boundaries. Cover nonblocking opening, shared in-flight
Start, zero source creation before the tap, unchanged warm-path request count,
deliberate retry of a lost lease reply with the same intent, expiry during idle,
pause/cancel, authentication retirement, close/reopen, seal and existing recovery.
Keep the iOS 17/Swift 6 compile and local implementer review evidence. No new data
schema, dependency, server operation, deployment or test fixture write is needed.

Release control is the coherent native app build for the existing synthetic
staging cohort, owned by the beta owner and superseded by the next qualified
candidate. Installed build 43 remains retained until a deliberate update. Recovery is
the existing Resume/Stop-and-upload flow; retain all prior packages and data.
Restore the prior coherent app build to remove anticipatory preparation only
after confirming the recorder is idle. No production rollout is authorized.

Measure immediate cold starts separately from starts after preparation finishes.
Moving work ahead of the tap does not eliminate its total cost or prove a physical
speedup. A fresh encounter that immediately starts after consent may still wait
for the whole preparation. Reducing repeated Core round trips remains open.
