# Native encrypted recording continuation

Tier 2. The owner explicitly requested native long visits and unattended software
verification. Reuse the existing native source handle, lease and reservation
journals, encrypted PCM sink and Core contracts. No new server endpoint, service,
dependency, consent policy or credential store.

A native owner maintains an already authorized source independently of the
WebView. Separate native tasks heartbeat and renew, so a slow network request
does not starve the watchdog. The source keeps its short monotonic deadline;
fresh verified Core lease and durable reservation receipts must precede extension.
Reserve after the previous window, replenishing available positions without
overlapping concurrent ciphertext commits or accumulating unused windows.
Retain pending renewal intents across transient failures; never extend an expired,
retired or stopped source. The original source owner keeps original stop proof.

This layer does not start audio or enable background capture. The host must bind
its active-source validator to the same native owner/current authenticated mount,
retain this owner until closure and report Core stopped only after physical
closure succeeds. Native host routing and background lifecycle activation follow
as separate integration work. Existing WebView capture remains unchanged.

Validate actual PCM core, lease/reservation owners and encryption with synthetic
consent and accelerated time; delayed renewal, retirement, clock rollback, stop
and closure retry. Exercise all 1,080 ten-second positions at full PCM volume
without a three-hour wall-clock/device test. Compile iOS and recheck formatting.
Software tests do not qualify physical screen-lock recording or live Core access.

Recovery leaves this additive module unused. Preserve all leases, reservation
rows, ciphertext and original source-stop proofs; no migration, key replacement,
fixture write, install or deployment is performed here.
