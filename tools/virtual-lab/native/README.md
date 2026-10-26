# Native preflight and passive observations

`python3 lab.py doctor CONFIG --output RECEIPT` performs read-only checks of the
owned target, build, Appium service and available virtual audio device. It opens
no app or stream. Build its metadata helper with `xcrun swiftc -parse-as-library audio.swift -o
/OWNED_ROOT/bin/audio`. Package presence, a route inventory or a successful
doctor is not a recording result.

The old `lab.py run` and `probe` commands fail closed before reading a config or
opening a device. Use the [resumable coordinator](../coordinator/README.md) for
normal sign-in, workspace, visit creation, consent, preparation, source delivery,
Record/Pause/Finish, save/reopen and dashboard checks. The coordinator owns the
journal, exclusive target lease, actual native observations and scoped recovery.
Do not restore the old runner to bypass an uncertain capture or session.

The example JSON files are diagnostic configuration skeletons. Their placeholder
builds, paths and locators are not delivered clients or observed UI. Configure
from an inspected owned build, and use the coordinator schema for a journey.

The target marker binds `purpose: scribe-synthetic-virtual-lab`, role and POSIX
hostname. Mac roles `owned-macos-guest` and `owned-macos-lab` additionally require
an actual hardware UUID hash matching the marker and different from
`controlHostHardwareUUIDSHA256`. Hash the lowercase IOPlatformUUID. Mac doctor
also checks actual session-lock metadata; a marker assertion alone cannot prove
an unlocked or independent target. The target requires its own interactive login.
An SSH process may receive no CGSession dictionary. The inventory helper then
requires IORegistry to report an unlocked console with exactly one logged-in
on-console user whose UID and name match the current non-root user, plus the
same UID owning `/dev/console`. Missing, malformed or conflicting observations
remain unavailable; a missing CGSession value by itself never means unlocked.

Apps reside under `TARGET_ROOT/apps` with matching bundle ID/build. iOS requires
`DTPlatformName: iphonesimulator` and the exact owned simulator UDID. Simulator
results do not qualify a physical device or TestFlight build. Appium binds only
to owned loopback. An existing session or uncertain recording must be reconciled
through the coordinator before starting another owner.

`visit-observer.mjs` observes normal native authentication and create/mount
responses through the owned debug WebView. It preserves original promises,
sends no requests and retains no tokens. Install it before normal sign-in and
visit creation. `readCreated()` observes actual server-generated scope;
`readCurrent()` requires a normal mount and current auth evidence. The coordinator
hashes the public native user ID in memory and compares the expected account.

After actual visit scope is known, `admission-observer.mjs` binds its run UUID,
workspace and appointment. Consent comes from the accepted normal admission
response with matching request nonce, revision and scope. A checkbox or locator
alone cannot manufacture consent. Recording observations contain native
phase/session/revision and numeric frame/chunk counts from ordinary product
polling. Pending mutations and mismatched replies invalidate previous state.
The observer sends no read or start command itself.

`describe()` exposes implementation identity and pending-reply counts.
`read()` expires admission evidence after 120 seconds; `readRecording()` expires
after 15 seconds. Historical `readTerminal()` is distinct from a fresh stopped
observation. Uninstall proceeds only when wrappers still belong to this run and
pending replies are settled; admission is removed before visit observation.
Uncertain capture retains observers and its target lease for explicit recovery.

The desktop uses passive observation of its own native protocol through a
verified owned inspector. Mac2 accessibility alone cannot claim the iOS seams.
Virtual input and ScreenCaptureKit application audio require separate real runs,
including saved audible words and transcript/note/dashboard verification. Never
record the physical host microphone, replace its installed Scribe, change its
default devices, or disable host security to make a preflight pass.

`wda_smoke.py SIMULATOR_MARKER --output RECEIPT` tests only Settings on the owned
simulator. It is historical bootstrap diagnostics, not Scribe acceptance.

Coordinator `scroll` uses a short W3C touch on a freshly measured clear WebView
margin. It refuses a focused editor, visible keyboard, zoom, an unmatched native
viewport, or a page without a clear margin. Full editable values are hashed inside
the owned WebView before and after each gesture; raw field text is never returned.
Changed fields, unexpected focus, or an unavailable post-touch observation retain
input uncertainty and the target guard. Dismiss the keyboard or repair a verified
edit through normal UI in a separately recorded recovery; scrolling never does so.
The old application-wide `mobile: scroll` path is retired because WebDriverAgent's
half-second press can focus an editor and subsequently type through the keyboard.

The ordinary Node tests cover geometry, context serialization, transport loss and
cleanup. The separate synthetic browser check requires an already installed
Playwright module: `SCRIBE_TEST_PLAYWRIGHT=/absolute/path/to/index.mjs node
tools/virtual-lab/coordinator/safe-scroll.browser.mjs`. It verifies full field hashes
and DOM margins; it does not qualify actual native touch or the live journey.
