# Provider desktop usability and audio

Tier 2. Owner authorized fixing all twelve audited desktop issues, with startup
and audio across visit types first. Implement and validate in this isolated
checkout. Existing source consent, native identity, start decisions, encryption,
recovery and confirmed-stop boundaries remain required. No production deployment.

1. Stable recording window, explicit audio source, microphone-only native capture
   for in-person/speakerphone, deliberate application selection and Start.
2. Reuse same-request mobile latency work; join independent local reads and omit
   only a redundant renderer review when trusted acquisition checks it afresh.
   Measure permission, admission, preparation and source request durations with
   fixed labels only. Never cache authorization or promise unmeasured latency.
3. Newest dated visits, search/status filters, persistent encrypted local hiding of empty
   visits, creation confirmation, smaller header and rows.
4. Clinical note first, optional template metadata, expanding fields, clear
   save-and-chart review destination; simpler wording correction and playback.

Playback must use a freshly authorized encounter/session and a source segment
from the current server transcript. Native main owns keys and bounded decryption.
Retain only encrypted local copies for recordings made after this change; existing
purged audio cannot be recreated. No plaintext file, secret, audio URL, arbitrary
path, or renderer-supplied time range. Dispose playable buffers on navigation,
logout and replacement. Keep original immutable envelopes and capture contracts.

Validation: TypeScript types/lint, desktop/flow/review regression tests, Swift
clock/permission/stop/selection tests, synthetic voice qualification, production
provider bundle and local UI walkthrough. Record exact checked commit and honest
physical audio/latency limits in PR evidence. Roll back via prior signed app/source;
retain app identity, device keys and existing encrypted stores. Split PRs within
2,000 changed lines/50 files; merge passing in-scope work under owner authority.

Implementer review found and fixed: duplicate session status read, microphone
half-gain in a two-source mixer, active/unconfirmed playback guard, foreign
session envelope rejection, playback key clearing during upload completion,
collapsed note-field sizing, status filter refresh, and geometry restoration
that would discard the provider’s resize. No independent review is claimed.
Native audio proof, encryption and stop barrier contracts remain intact.

Local validation: 529 capture tests, 69 review tests, 216 desktop tests; native
Swift suite and generated speech plus synthetic pipe checks pass. Later changes
receive focused types/lint and recording/storage/window/IPC regression checks.
The compiled provider recovery check passes 23 scenarios after adapting its
outdated countdown expectation. The complete workspace script has older fixture
assumptions (missing edit journal, ResizeObserver and dialog implementation);
it is not passing evidence. Focused workspace tests pass. Installed walkthrough
is required to verify this complete user journey.

Follow-up installed walkthrough: build 48 exposed a visible frame that remained
on the encounter list after the accessibility tree advanced to recording setup.
Native catalog and mount timings completed; process samples were idle. Candidate
49 disables Chromium background throttling for this one provider window, keeps
all sandbox/permission/CSP controls, and adds fixed duration-only timings around
the full main list/open/journal/preferences operations. Native picker focus must
not suspend preparation or stop/recovery rendering. Confirm improvement in the
signed installed app before claiming latency reduction. Rollback preserves the
prior build 48 and its keys/configuration. This continues the owner's all-twelve
authorization; no cloud/service deployment or permission expansion.

The complete compiled workspace fixtures now include the browser APIs and edit
journal required by the real UI, the current translation blocker, close preload
and save wording. Both normal and uploaded-recovery checks pass, including
revocation and explicit unsaved-edit decisions. These checks use an invented
backend and do not substitute for installed or physical audio qualification.

Build 49 measured about 25.2 seconds from fresh recording preparation to the
source picker: admission 6.7s, trusted review 3.7s, parallel capabilities/key setup
6.8s, then compound window preparation 7.9s. Audio readiness was 95ms. Bring the
iOS initial reservation count (30 rather than 90) to fresh desktop compound
windows. Keep retained requests byte-for-byte and continuation batches unchanged;
do not change consent, lease duration, source admission or total capture budget.
Measure a fresh visit in signed build 50 before attributing a latency improvement.

Build 50 measured about 25 seconds again; its 30-chunk batch did not show a
measurable speed improvement. Most time remains admission/review/key/window
service work. Do not claim the initial-batch change solved startup latency.

Owner requested eliminating the meeting-window popup. Build 51 adds version 3
metadata discovery to the existing signed presentation helper and displays the
bounded Zoom/Chrome labels in the recording screen. Only current opaque row IDs
cross renderer IPC; main retains app/PID/window and native capture revalidates
them after the existing fresh server decision. No default or remembered choice,
new permissions, screenshots, title logging/storage, or capture on row selection.

Installed build 52 confirms the inline selected label remains visible, Start fits
the existing window, and Refresh clears selection and disables Start. No source
was started. The same walkthrough found the list's Show dropdown unresponsive;
replace it with visible local filter buttons, including Hidden visits. A compiled
UI regression checks local filtering, hide, remount, restore and zero recorder
commands. Physical audio and service startup latency remain separately open.

Build 53 verifies persistent hide/restore and directly accessible draft filters.
The installed telehealth template uses prefixed SOAP headings and MRN/payer/site
administrative fields. Recognize those exact headings so clinical sections lead
and administrative fields remain collapsed, without changing template keys or
save order. At narrow window widths the transcript uses the page scrollbar;
the optional wide comparison panel retains its separate bounded view.
Refresh invalidates IDs. Meeting consent opens inline selection without starting
audio; its main Start button is the deliberate capture action. Old v1/v2 native
contracts remain available for older hosts. Stop indicators and ownership remain
unchanged. Verify compiled IPC/UI, actual native metadata pipes, cancellation and
signed installed layout; roll back to signed build 50 with existing stores intact.

Reuse mobile's visible preparation in the trusted standalone desktop composition:
main owns the same fresh preparation task while the admitted recorder exposes a
fixed preparing state. Audio/window controls stay disabled until metadata and
read-only window discovery finish. The current consent-screen microphone Start
waits in memory for that exact attached view; meeting visits still need explicit
window choice and Start. Navigation/revocation discards the intent and joins late
metadata before releasing keys/stores. Failures show a fixed recovery message,
retain encrypted work and cannot start. Diagnostic compositions continue waiting.
This improves time to visible controls; service readiness still requires timing
measurement, and no physical audio result is implied. No server route, lease,
consent, permissions, capture grant, native source or cloud configuration changes.

Recheck the passage playback guard after journal/review/key reads, throughout
bounded decryption and before publishing playable bytes. Capture the original
recorder owner so a delayed review cannot publish after replacement, even when
the replacement is ready. Recorder acquisition remains available and takes
priority; an obsolete Listen request refuses without delaying recording. Verify
late recorder opening, ready replacement and active phase changes using deferred
synthetic review responses. Preserve fresh server review, key custody, original
audio, buffer clearing and playback disposal on navigation.
