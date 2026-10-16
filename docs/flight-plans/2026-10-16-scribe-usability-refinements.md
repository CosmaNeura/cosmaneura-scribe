# Scribe usability refinements

Risk: Tier 1. One shared provider UI outcome, distributed through the existing
desktop owner candidate and iPhone internal/pilot candidates. The owner has
authorized implementation, merge and app rollout in this conversation.

## Behavior

The virtual evaluation produced ten related refinements:

1. Mobile Conversation is a separate view with a visible Back to note action;
   editor, private note, caret and scroll state are preserved in memory.
2. Call recovery distinguishes changed, unselected and unavailable calls.
   A paused visit still requires its original call or Finish visit.
3. Draft saving, saved and unconfirmed states use short, explicit wording.
4. Recording-access repair steps are numbered and collapsed until needed.
5. Ready and paused screens summarize the selected call behind Change.
6. Name-only setup continues with Continue to recording setup.
7. Audio scope explains the microphone, app audio and other Chrome tabs.
8. Prior captured audio offers Resume recording; an empty cancelled start
   still offers Start recording.
9. A ready access recheck is optional; a required check remains prominent.
10. Laptop preparation keeps consent and Start visible at 1024 by 768.

The consent state machine, patient identity rules, private-note destination,
native capture, encryption, authority checks, API and schema are unchanged.
No new dependency or architecture is introduced.

## Release control and reconciliation

- Control: existing native candidate distribution, owner Shawn.
- Initial cohort: existing desktop owner candidate; existing iPhone Scribe
  Internal and Shawn Pilot groups. No broader cohort activation.
- Expiry/review: October 30, 2026.
- Baseline: signed Mac 85 and iPhone 70; retain both as rollback artifacts.
- Choice: replace their provider UI after this change is merged and candidate
  source, embedded UI bytes, signature and distribution state are verified.
- Current main baseline: f4f3f69fa365fc1aa939284f8b1053e1957be461.
- No backend deployment, migration, or production promotion workflow applies.

## Validation and evidence

Use relevant local tests, types, lint, compiled provider/native-host checks,
390 by 844 mobile and 1024 by 768 desktop CUA checks, and an independent
non-implementer review after the final substantive push. Repository Actions
remains disabled. Local execution is not hosted CI or a GitHub approval.

Run recording-start timing tests after the UI refinements pass review. Measure
Start to controller/native recording confirmation and visible Recording state;
measure first encrypted saved audio where the real queue is exercised. Record
sample counts and synthetic access, backend and native delays separately.
Virtual DOM/controller timings do not establish physical iPhone, macOS audio
hardware, screen paint, or real Meet/Zoom performance.

Bind raw results and compiled inputs to the final PR commit in durable PR
evidence. UI checks use fictional, consented fixtures. Audio harnesses require
a valid synthetic consent record before any processing. No clinical data,
transcript, patient identity, credential or audio URL is written to logs.

## Recovery and acceptance

Health signals: consent still blocks Start; selected call and failed access
checks block invalid recording; Start/Resume/Finish remain usable; saving
confirmation is honest; private notes remain separate; return navigation
preserves edits. Confirm installed candidate version and embedded UI hashes.

If these regress, revert the shared UI commit through a normal PR and restore
Mac 85 or distribute iPhone 70 through the existing beta flow. Retain encrypted
visit state and finish pending saves through the supported recovery controls.
Live Meet/Zoom capture and physical iPhone background/lock-screen acceptance
remain separate hardware checks; synthetic success does not mark them passed.
