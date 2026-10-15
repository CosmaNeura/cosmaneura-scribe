# Scribe acceptance backlog

Owner: release owner. All gates are NOT RUN. Source-review the current target
before populating batch.example.json. Native iOS/Android/TestFlight behavior
requires a separate device verification lane; browser evidence does not prove it.

| Gate | Definition of done | Source starting point |
| --- | --- | --- |
| C01 baseline | Both bots identify synthetic-only target, tenant, release and fixtures; capture remains consent-gated | apps/capture/e2e/pages/capture-page.mjs |
| C02 profile A | Bot 1 completes approved synthetic capture, recovery and read-only completion checks | apps/capture/e2e/specs/capture-flow.pw.mjs |
| C03 profile B | Bot 2 repeats on own isolated target/profile, with an approved edge sequence | Same spec; review controls actually present on target |
| C04 handoff | Approved synthetic note handoff reaches Core with correct record lineage and both repo pins | scripts/check-review-note-handoff.mjs; paired Core handoff |
| C05 boundaries | Approved tenant/role isolation and consent denial cases reveal no cross-tenant data | CLAUDE.md; current API route guards |
| C06 upgrade | Owner-controlled test upgrade preserves queued synthetic state and profile inventory | Existing native/capture recovery runbooks |
| C07 recovery | Owner rehearses recovery on disposable target; independent bots verify state | Existing rehearsal controls; no automatic restore |
| C08 operations | Approved provisioning/closure/support checks pass; unavailable product features explicitly parked | Source-reviewed implemented routes only |

The existing browser suite is an isolated loopback mock-BFF rehearsal, NOT
proof of real identity/tenant isolation or deployed API readiness. It uses one
fixed session and port pair; do not run two copies against that same fixture.
Retain fake microphone input and disabled screenshots/video/traces. Do not use
a physical microphone. A deployed surface must support an approved synthetic
capture path before it is eligible; otherwise report BLOCKED.

Candidate 10-case C02/C03 pilot, once the target supports the reviewed controls:

1. Open own fresh profile: synthetic marker and `idle` observed.
2. Attempt begin without consent: observe disabled gate (edge).
3. Accept consent and begin: `ready`; no audio captured before record.
4. Start fake-microphone recording: `recording`.
5. Hold upload using the approved test harness: `1 encrypted · 90 reserved`.
6. Close page after durability; reopen same own profile: `paused` (edge).
7. Stop recovered capture: `uploading`; held upload remains pending.
8. Release test harness upload and refresh: `ready`, `0 pending`, read-only
   synthetic transcript. Check the view has no editable input.
9. Scoped cleanup: close only own disposable context and retire own fixture
   through approved harness reset; no transcript deletion/API bypass.
10. Inventory: record completed synthetic session ID and any retained fixture;
    protected fixtures remain unchanged.

These are candidates grounded in capture-page.mjs, not a pre-pinned runnable
batch. Annotate exact source paths, bot prefix/fixture IDs, harness ownership and
how the bot requests hold/release before queuing. Harness setup is engineering
work; a browser bot does not edit app code. Use an approved metadata-only
observation record when screenshots could contain upload credentials or content.

Evidence packet: cases, UI/API commits, sanitized browser observations, synthetic
IDs, final/protected fixture inventory, failure issues and independent verifier.
Fixer validation: `uv run pytest`, `npm test`, relevant lint/types, and
`npm test --prefix apps/capture/e2e` when browser inputs change, with the existing
local harness prerequisites. Actions remains disabled. No automatic deployment.
