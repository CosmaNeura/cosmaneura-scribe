# Consent-triggered recording preparation

Risk: Tier 2 (consent/session timing). Owner: John Clemente. Existing Scribe
internal and Shawn Pilot beta cohorts only; user authorized this plan on October
17. Existing rollout authorization covers these apps and staging. Actions remains
disabled. No production promotion, schema, dependency, identity or network change.

## Evidence and intended behavior

Installed Mac86/receiver47 measured 5.444–5.559 seconds from Record to native
ready. Admission was3107ms, secure recorder preparation863ms, source preparation
958ms, and native helper startup477ms. A prior current-receiver trial was
7.230–7.331 seconds. iPhone72 completed a fresh synthetic recording, nonzero
input/conversion, saved review and native release; measured6.052–8.527 seconds
under the documented clock assumptions. Measurements remain separate trials.

Fresh explicit consent starts the existing admission and secure preparation
pipeline. Record remains a separate deliberate action and alone starts listening.
App-opening and patient-selection work may warm existing authenticated transport,
local infrastructure and metadata; it must not fabricate consent, activate audio,
or duplicate work that already occurs. Final Record retains current account,
visit, consent, source, expiry and one-use authorization checks.

## Implementation and safety boundaries

Use the existing idempotent consent/session APIs and native recorder preparation.
There is one owned preparation flight per current visit/generation. Preserve
durable pending keys and exact recipe recovery; uncertain writes never create a
replacement key. Cancellation, leave, sign-out, foreground loss and scope changes
fence late results and await owned cleanup. A reopened or recovered journal never
automatically records. Source choices must transfer without creating Record intent.

Withdrawing the checkbox cancels local preparation and its queued Record intent;
it does not add server consent-revocation semantics. Retained recovery requires a
new unchecked-to-checked consent action and manual Record. Language and visit type
remain the original attestation. Review the current native source before recording;
do not reconstruct hardware or call choices from visit type. A virtual visit can
legitimately retain microphone-only fallback. Existing native custody recipes,
fresh call ambiguity checks and authorization expiry remain authoritative; a
delayed prepared owner receives no extended ticket or automatic renewal.

Do not combine consent/session mutations by removing Core's fresh intermediate
claim. Do not invent an admission window without the client's durably wrapped
key and binding/lease/reservation recipe. A future combined contract needs its own
receiver-first, backward-compatible reviewed implementation and equivalent fences.

Stage the UI behavior behind an explicit reversible release control with this
owner/cohort and review by November1. Keep the currently installed UI72/Mac86 as
recovery artifacts. Returning to the previous UI does not erase prepared sessions
or their journals; retain existing recovery and never start from them implicitly.

## Verification and release

Focused tests exercise consent and cancellation, delayed/uncertain admission,
single-flight Record joining, source choices, late ownership handoff, navigation,
reopen/recovery and no pre-Record audio. Existing native and bridge checks still
apply. Run appropriate type/lint/build checks and independent nonimplementer
review after the final substantive push. Record exact SHA and results in the PR.

Only merged, independently reviewed source may build the app candidates. Qualify
signed binaries, install on the owner's Mac/iPhone, and test fresh synthetic visits.
Measure consent-to-native-ready as well as Record-to-native-ready, including
immediate Record, short pauses, warm/cold starts and interrupted preparation.
Do not claim total-flow improvement from moving a wait earlier or count historical
trials as new release measurements.
