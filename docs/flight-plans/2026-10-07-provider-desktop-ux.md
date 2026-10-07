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
