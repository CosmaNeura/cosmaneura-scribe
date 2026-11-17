# Native Ready-source workflow compatibility

Risk: Tier 2 because this changes the accepted native source-start actions.
Owner: repository founder. Scope: one API transport module and focused tests.

Mac131 advertises Ready-source preparation. iPhone94 also uses the existing
standalone native source prepare/authorize contract. The production Core
workflow receiver routes source-start through ProviderNativeWorkflowTransport,
which accepts only stop/cancel and rejects prepare/authorize before dispatch.
The current iPhone94 normal recovery returned source-start HTTP503 before audio
started; the same rejection is reproduced against the frozen transport offline.

Accept the two existing native-only actions and validate their existing receipt
models. Preparation must remain unissued and unexpired. Authorization must
match the original owner proof and retain the existing fifteen-second decision
limit. Both must match the original actor, source, lease, generation, recording
position and capture deadline. Preserve all four transport freshness fences,
the scoped Core workflow operation, and the Core gateway's unchanged current
creator/session/consent authorization before and after downstream I/O.

Generic renderer capture-operations still excludes source_start. The combined
sourcePrepareForStart path and stop/cancel recovery remain intact. No Core,
SessionPrep, client, schema, identity, role, private prepared context, or cohort
changes belong to this patch. No capture begins merely because Ready-source
preparation succeeds.

Validation: both desktop and iOS receipts; revocation at every transport fence;
wrong actor, lease, source, position or owner proof; expired/oversized decisions;
preparation carrying authority; cookie rejection; renderer and changed-mount
rejection; existing composite-cache and combined-source regressions. Run focused
tests, changed-file Ruff, strict transport Pyright and diff checks. Obtain an
independent review against the final pushed commit before merge.

Promotion is founder-owned after merge. Preserve the qualified API image's other
bytes and runtime configuration. The separately reviewed SDK/HTTP reuse flags
may accompany the same rollout; their performance claim remains unqualified
until normal client workflows measure it. Verify iPhone94 normal recovery and
Mac131 explicit Start, accepted PCM and normal save/listen. Do not describe the
earlier eighteen-second startup as fully explained by this contract defect.

Rollback: restore the prior API transport image and, if separately applied,
restore the two reuse flags. Existing native owner-proof stop/recovery remains
the cleanup boundary; never discard ambiguous preparation or recording custody.
