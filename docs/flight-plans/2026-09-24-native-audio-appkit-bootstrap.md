# Native audio-helper AppKit startup

Risk: Tier 1, deployment-sensitive and reversible. Scope: the existing staged
desktop provider cohort, with owner-operated installation and capture acceptance.
This change does not authorize activation beyond that cohort.

## Observed failure and correction

The installed build 7 helper exited with SIGABRT before native readiness. The
matching metadata-only macOS report places the fault on a cooperative worker in
`SLSGetDisplaysWithRect`, called by `SCContentFilter` construction in
`MacMeetingAudio.start`. No exception assertion text was available. The helper's
async entry point had not initialized `NSApplication` or its AppKit event loop.
The separately packaged presentation helper already used an application loop.

Initialize the audio helper's application on the OS main thread, prohibit its
activation, and run its existing asynchronous mode dispatch inside the AppKit
loop. Construct the screen filter and stream on MainActor. Recheck capture phase
and task cancellation after that suspension, before owning a session or installing
any audio source. The existing permission probe and explicit setup remain distinct;
no mode, prompt, window-selection rule or recording authority is added.

The SDK's `SCContentFilter` declaration does not explicitly state a main-thread
requirement. This correction addresses the observed WindowServer/AppKit startup
boundary; the exact private assertion condition is not claimed as established.

## Local validation and limits

- Compile the complete Swift package and run its native tests.
- Run `scripts/desktop-native/check-appkit-bootstrap.py` on macOS. It compiles the
  actual helper entry point unchanged against a noncapturing test stand-in. Fresh
  processes verify AppKit initialization, prohibited activation policy, execution
  on the OS main thread and MainActor reentry through the application loop.
- Compare the same fixture against the prior helper entry as a negative control.
- Run the real Swift-to-Node pipe fixtures, including a child exiting before ready.
  Explicit discard waits for the owned child to exit and clears pending PCM work;
  it does not invent a normal stop receipt or complete an empty upload.
- Run desktop lint/typecheck and Python lint/typecheck for the fixture runner.

The AppKit regression cannot run inside a sandbox that denies its normal service
connection. It does not query permissions, enumerate windows or capture audio.
It does not execute the real screen filter, so installed owner-operated recording
remains required. The original static/generated-PCM checks did not exercise this
cold AppKit startup path.

## Release and recovery

Build only from the reviewed, merged source. Preserve the existing bundle identity,
signing configuration, issuer, endpoints, permissions and custody. Retain the prior
signed package and complete installed bundle before a separately guarded update.
No iOS, service, database or API input changes are included.

If native startup fails, retain saved audio and use the existing explicit Stop
recovery. An in-flight stop may reject when the child exits; a later discard can
confirm that owned child is gone without a protocol stop receipt. Keep unconfirmed
cleanup visible. Never reset a session, create replacement custody or automatically
retry capture to hide a startup failure. The earlier package is retained for
recovery evidence; it is not a successful recording baseline.
