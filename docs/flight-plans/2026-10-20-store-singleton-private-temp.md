# Store singleton temporary directory

Risk class: Tier 2. Owner: repository owner. Scope: the optional Mac App Store
entry, with synthetic qualification before a signed Store candidate is used.

The actual Store102 process exited cleanly before its provider or window opened.
Closed stderr classification identified Chromium's remote `/S/SingletonCookie`
creation failure with `File exists`, followed by `Failed to create symlinks.`
That establishes a failure after lock acquisition. It does not establish whether
the prior cookie belonged to a terminated or active process.

Electron 44.4.3 pins Chromium 152.0.7977.130. Its singleton patch chooses a fixed
`S` child under the macOS temporary directory for sandboxed apps. Chromium's
`GetTempDir` reads `MAC_CHROMIUM_TMPDIR` before `NSTemporaryDirectory`; changing
Electron's `app.setPath("temp")` would only override PathService and would not
change that call. The macOS singleton bind and connect both use the extended
253-byte sockaddr path; the limit applies to the complete UTF8 socket path.

The Store entry refuses any inherited override before obtaining an OS path.
It canonicalizes Electron's OS-provided temporary root, validates private owner
custody, and creates a fresh 0700 child. A private, frozen, single-use capability
sets the vendor override only during the synchronous call to the unchanged
Electron single-instance guard, then clears it in `finally`. The capability
cannot supply a Boolean result or replace the actual application lock call.
Store requires that capability; direct Beta rejects it and keeps its existing
lock path. The durable Store userData directory, native shared fence and
credential namespace remain unchanged. No previous lock, cookie or temporary
directory is deleted. Chromium owns its new `S` child; the OS may clean its
private per-launch parent. Preparation failures retain a fixed numeric stage18.

The shell window title now uses its already validated application name so Store
shows its Store title while direct Beta retains its prior title.

Qualification is source-only: focused temporary-directory, environment-lifetime,
single-instance rejection and Store-entry tests, desktop types and changed-file
lint. These fixtures do not execute Electron, XPC services, Clerk, Keychain or
audio. Exact commands, source pins and results accompany the final PR. Independent
review must bind the final substantive head. Passing fixtures do not qualify
OS sandbox eligibility, live second-process notification, completed-worker
reply timing, sign-in, storage, recording or saved audio review.

After source review and merge equality, build the canonical host once with the
retained renderer. Reuse all four actual native102 products only after their
70 declared native inputs,267 generated auth inputs,256 materialized inputs and
233 vendor files match current source. Preserve prepared role claims and18
original Clerk resources with honest retained-producer lineage. Require a
separate actual-output review, then Root-owned signing and one normal startup.
Observe a live primary and a second process's refusal/notification during later
bounded runtime qualification; never bypass a failed lock or delete an old one.

Recovery: retain all prior signed artifacts and observation receipts, do not
erase userData, keys, fences, leases or singleton files. A failing new candidate
stays unavailable. Reverting this source restores the previous Store temporary
layout without altering recorded data or direct distribution. No backend,
renderer, native identity, permission, profile or production-clinical scope
changes are included.

Primary references:

- [Electron singleton patch](https://github.com/electron/electron/blob/v44.4.3/patches/chromium/process_singleton.patch)
- [Chromium Apple temporary paths](https://github.com/chromium/chromium/blob/152.0.7977.130/base/files/file_util_apple.mm)
- [Chromium singleton socket bounds and cookie checks](https://github.com/chromium/chromium/blob/152.0.7977.130/chrome/browser/process_singleton_posix.cc)
- [Electron single-instance API](https://github.com/electron/electron/blob/v44.4.3/docs/api/app.md#apprequestsingleinstancelockadditionaldata)
