# Resume after interrupted recording finalization

Tier 2: native recording recovery. Within the owner's long-visit reliability and
essential UX scope; preserve original keys, ciphertext and completion intents.

If physical stop saves a final packet but sealing fails, the host retains its
older pre-recording journal snapshot. Resume currently selects that snapshot's
old chunk position. An offline reproduction restarted at position zero after
position zero was already encrypted; the next packet cannot be saved there.

Before resuming this specific failed-seal state, reuse the existing authenticated
reconciliation scan. Choose the next position and byte count from its result.
If verification still fails, remain paused without acquiring another source.
If the seal committed but its response was lost, recover the frozen completion
and present upload recovery instead of recording again. Normal starts and
successful pause/resume do not gain another scan. Cancellation and current
account checks continue to fence every asynchronous boundary.

The existing failure metadata now identifies unconfirmed saving in the UI.
Offer explicit retry saving/upload or recovery/resume, preserving the native
owner as the only authority to record. Do not infer an empty recording from an
unconfirmed save with zero cached chunks.

Validate generated PCM/encrypted records across failed seal, repeated failed
scan, exact next position, lost committed seal response, empty capture and
unchanged keys/completion intent. Reuse the native run/host harness, iOS17 type
check, TypeScript tests and compiled provider UI. No microphone or live service
is needed for these checks. Physical acceptance remains distinct.

Release through normal same-identity native packages for the existing approved
staging cohort, owned by the beta owner and re-evaluated on candidate acceptance
or replacement. No server, schema, dependency, configuration or stored-format
change. Keep existing installed builds until a package update is prepared.
Recovery retains those builds and all recordings/keys; a failed seal can also
use the existing stop/upload retry or encounter reopen without deleting data.
