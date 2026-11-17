# Keep recording status in the visible Scribe window

Owner: Scribe operational beta owner. Tier 2: native recording-awareness surface.

The current main host deliberately leaves its window at ordinary macOS level,
without activation, pinning, resizing, or switching Spaces. The native recording
presenter nevertheless accepts only a status-level main window as a substitute
for its separate status panel. Those policies are incompatible: the normal
Scribe recording screen cannot suppress the redundant foreground panel.

Accept ordinary-or-higher window level when the existing native checks prove the
exact main-owned window is opaque, large enough, entirely within a current work
area, and uncovered by another application's visible window. Keep the main's
responsiveness gate, fixed window identity, live owner verification, and 2.5-second
heartbeat expiry. Do not accept a renderer visibility claim, relax occlusion, or
raise the main window. The menu-bar recording indicator and its Stop action stay
active. A hidden, minimized, covered, stale, or otherwise unproven main window
still restores the independent native controls. A failed Stop always retains the
independent warning and Retry stop controls; only confirmed source shutdown may
publish inactive.

Qualification uses the existing pure window-metadata and handoff tests. The new
ordinary-window assertions must fail on the prior status-only predicate. Recheck
foreign owner, transparent/small/off-work-area/occluded windows, expiry, immutable
window binding, fallback restoration, and no hiding after unconfirmed Stop. These
tests construct no recording source or visible window and launch no app or native
presentation helper. Run the applicable native compiler checks for the eventual
Mac release package. Actual installed window/Space behavior remains a separate
normal operational check, after the current recording workflow completes.

Publish the final independent review before integration. This source preparation
changes no current running app, permissions, capture authority, server, database,
credential, or package. Include the merged change in the next Mac package; it has
no iPhone impact. Recovery: revert the predicate/test changes and distribute the
prior verified Mac package, preserving all accounts, recordings, and receipts.
