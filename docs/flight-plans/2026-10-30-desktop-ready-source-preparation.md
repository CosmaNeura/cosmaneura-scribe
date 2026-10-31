# Desktop first-Record source preparation

Risk: Tier 2, because the source-owner lifecycle surrounds a capture-authority boundary. This changes preparation scheduling; it does not change consent, session authorization, lease or capability durations, proof custody, process fences, or the native window checks.

The measured Desktop18 R3 took 5,128.280 ms from provider start to first accepted PCM, including 4,322.358 ms in sourcePrepareForStart. Its 386.548-second Ready interval had expired the original first-source handoff. Those numbers remain failed live evidence; moving preparation off Record is not a measured performance result.

After existing consent/session/lease preparation has produced an untouched Ready owner (generation 1, sequence 0, no retained coverage), the trusted main process may invoke the existing prepare-only native RPC. Native retains the original server preparation expiry, at most two minutes and no later than the lease deadline. The helper advertises metadata support only in its ready state; an older helper retains the existing Record path.

Ready preparation returns only the checked grant, process fence and original expiry. It never calls the combined prepare-and-authorize path or returns a capability to the renderer. A timer refreshes only after the original expiry. Main serializes preparation, cancellation, mount and retirement for the visit; a confirmed sourcePreparationRelease removes the old owner before creating a new proof. A missing prepare or cancellation reply retains the original correlation and blocks replacement until cleanup succeeds.

Record stops the timer and joins the pending preparation, then runs the existing storage and window-choice checks. If the same session, binding, lease, generation, deadline and first sequence still match, it uses that exact unissued grant and process fence. The existing controller subsequently calls real sourceAuthorize once, after the button and window choice. Native also rejects an expired original unissued preparation before requesting authorization. Absent or expired warm preparation uses the existing combined Record path only after prior custody is conclusively retired. Resume and recorded continuation remain on that existing path.

Navigation, authentication revision, Ready exit, explicit audio-mode/input changes and observed input changes cancel unused preparation. A pending reply is joined before releasing the visit's encrypted custody. Lost cleanup keeps Record/replacement unavailable; it does not invent physical-stop confirmation or release an already claimed source via preparation-only cleanup.

Validation is the focused Desktop recorder/backend/workspace tests, original-expiry native harness, lint and type checks. No production, receiver, Core, database, iOS native code, dependency or cloud configuration changes are included. Rebuilt Desktop Record-to-first-PCM and complete Save/reopen/Listen/dashboard qualification remain required. Remote sourceAuthorize latency is unmeasured.

Recovery is the prior reviewed Desktop app/helper pair. Do not mix a new main bundle with an older native capability advertisement or reinterpret any retained old source proof. No data migration or destructive rollback is needed. Parent performs independent review of the final substantive commit before integration.
