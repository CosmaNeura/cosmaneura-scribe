# Prepare native sign-in while a desktop visit opens

Tier 2. Owner authorized token preparation October 15. The installed Desktop 81
is unchanged by implementation. No SDK account changes, storage permission,
recording, playback, signing, release or cohort expansion occurs during tests.

After a successfully verified mount with admission metadata capability, prepare
one token using the existing SDK. No sign-in UI, server mutation or audio action.
Hold one RAM-only task/ticket for that exact mount, account, session and revision.
Claim once for the matching fresh-consent Start before any await. Require less
than one second since mint to leave four seconds for the measured setup chain.
The original five-second monotonic and JWT/wall deadlines survive admission and
window/source transfer. Never reset a clock or retry uncertain server I/O.

Fresh server account and consent checks remain unchanged. Local blocked access,
revision/account/mount changes, cancellation, clock changes, close, unrelated
activity and expired credentials decline reuse. Speculative failure leaves idle
sign-in state intact; ordinary Start keeps its existing fail-closed behavior.
One request per mount; no periodic SDK polling. Phone remains opt-out.

Validate the actual native owner, wire and proof journal with synthetic clocks,
tokens and receipts: exact use, expired/older/mismatched tickets, original deadline
transfer, soft failure, late reply, cancellation, account change and concurrency.
Compile both macOS/iOS shared sources. No physical speed pass follows from these
tests; measure full consent-handler to retained native audio when devices are
available. Record visit-opening latency separately so work is not hidden.

Independent exact-head review required before merge. Recovery reverts desktop
opt-in or this native patch; never reset Keychain or delete retained recordings.
