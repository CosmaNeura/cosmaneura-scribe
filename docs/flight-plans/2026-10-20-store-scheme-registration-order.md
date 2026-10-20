# Register the Store app scheme before readiness

Tier 2: the existing packaged renderer scheme is a security boundary. This
change preserves its exact privileges and changes when the Store entry
registers it. The owner authorized this isolated source correction and its
independent review; signing and runtime qualification remain separate gates.

## Problem and outcome

Electron 44.4.3 requires `protocol.registerSchemesAsPrivileged` before
`app.ready`. The Store entry awaited filesystem checks for its isolated
userData directory before the shell registered the scheme. Readiness could
advance during those awaits, causing the native Electron API to reject the
registration. The direct entry already enters the shell synchronously.

The Store entry now checks the official MAS runtime and registers the existing
scheme synchronously, before any path preparation await. The shell reuses only
a successful registration of that same protocol object. Failed registration
remains failed and is never retried after readiness. The direct entry retains
its runtime/name and single-instance checks before its single registration.

The observed ordinary Store100 startup emitted only bootstrap stage 5 and
stopped before provider acquisition. The ordering defect is proven from source
and Electron's contract; that observation does not identify the exact throw
site or prove this correction resolves every startup blocker.

## Closed diagnostics

Existing bootstrap stages 1–8 and the private bounded journal format remain.
Store-only shell observation adds 9 identity/process/package checks, 10 the
single-instance lock, 11 scheme registration, 12 startup listener/app root,
13 readiness, 14 renderer verification, 15 session/diagnostic construction,
16 session protocol/request filtering, and 17 lifecycle listeners and the
transition into provider acquisition. The optional observer is best effort;
throwing it cannot change startup or cleanup. Stage values outside 1–17 are
ignored. No error text, paths, identities, credentials, or content are logged.

## Qualification and recovery

Focused injected checks model readiness advancing during asynchronous path
preparation, one successful registration, invalid MAS rejection, failed
registration without retry, and throwing observers. Existing host ownership,
late acquisition, stop/drain, and bounded diagnostic checks remain applicable.
Actual commands, counts, exact source tree and independent review are recorded
in the final PR evidence; none of these checks launches Electron or native
services or qualifies signed sandbox/Keychain/XPC/capture behavior.

The next candidate requires a canonical host build, exact unchanged native and
renderer reuse proof, independent output/signature review, and one bounded
normal startup. Its fixed diagnostic reader must admit the new 1–17 range.
Store100 artifacts, signature, failed-startup evidence and private namespace
remain intact. Recovery retains those artifacts and declines candidate
activation; it does not erase or adopt credentials, recordings or direct-app
data. No IDs, groups, profiles, auth/consent/storage, TCC, renderer privileges,
provider contracts or native stop policy change. No schema or backend rollout
applies; public clinical use remains outside this source qualification.

Primary Electron references:

- https://github.com/electron/electron/blob/v44.4.3/shell/browser/api/electron_api_protocol.cc
- https://www.electronjs.org/docs/latest/api/protocol#protocolregisterschemesasprivilegedcustomschemes
