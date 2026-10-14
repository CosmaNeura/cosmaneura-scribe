# Bounded desktop source-start token handoff

Tier 2: native session credential reuse. The owner explicitly approved this
bounded change and one isolated non-implementer review on October 14, 2026.

Desktop 80 measured 8.35 and 9.30 seconds from the consent handler to native
audio readiness, with another failed start. A fresh token was still requested
for source-start-ready after the admission/window sequence. This patch removes
that additional SDK request only for the same freshly admitted start. It does
not establish a measured improvement or satisfy the five-second acceptance.

## Scope and order

1. Branch from installed Desktop 80's merged source, 70156d4, excluding the
   held interruption-diagnostics PR. Keep the installed build until qualification.
2. After successful fresh-window publication, carry the original admission
   credential in native RAM to one matching source-start-ready request. Retain
   the original five-second, checked-at and JWT deadlines. Bind the complete
   window, session, consent, account, revision, mount, lease and generation.
3. Claim before awaiting; a mismatch/expiry before dispatch uses the existing
   fresh SDK path. Cancellation, auth changes and replacement mounts prevent
   publication. An uncertain wire response never causes automatic replay.
4. Compile the real helper offline and run synthetic token/wire/storage checks,
   existing source-authority/custody regressions and platform type checks. No
   physical audio, Keychain, account or server changes are part of these tests.
5. Record exact final source and commands in PR evidence; obtain the authorized
   isolated review after the final substantive push. Actions stays disabled.
   Merge under the owner's established local-validation authority only after
   resolving review findings. Build/sign/notarize the exact merged source using
   the existing beta identity and configuration before any install.
6. Measure three fresh physical desktop starts with approved fictional content
   when the Mac is available. Keep phone and remaining UX acceptance open;
   virtual token counts cannot qualify capture, latency or clinical note quality.

## Recovery and reconciliation

Installed Desktop 80 is retained temporarily as the current recovery baseline.
Recovery uses its retained signed/notarized package and previous native fresh
source authentication path. No backend, schema, consent, configuration, token
policy or global SDK cache changes are required. No production promotion is
included. The diagnostic-only build remains held separately.

Only the owner can authorize scope beyond this same-start handoff. Do not
extend the TTL, transfer credentials through renderer/IPC/storage/logs, or
reuse them for renewals, notes, another start or another account.

## Local validation

The exact-head PR receipt records source hashes and complete commands/results.
The focused native fixture covers 42 initial-window and 47 source-handoff cases,
including real native source-owner grant/decision checks, one-use consumption,
scope/receipt/AAD rejection, immutable expiry, clock changes, cancellation,
account/mount changes, delayed responses, consent mismatch and ambiguous loss.
It uses in-memory SDK/wire/storage and no audio. The existing desktop source
suite covers 44 authority/custody cases. Native run/binding regressions and iOS
type checks use synthetic ephemeral RSA keys; recorder JavaScript regressions
use local loopback fixtures. None is physical recording acceptance.
