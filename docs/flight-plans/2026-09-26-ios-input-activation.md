# Preserve deliberate microphone selection through iOS activation

Tier 2: native microphone lifecycle. No authorization, consent, encryption,
storage, external contract, service configuration or dependency changes.

The physical iPhone accepted one start after app launch, then rejected Resume.
Its enum-only trace shows a route notification during session activation,
followed by driver rejection before tap installation. The live adapter treated
that notification as an interruption before it had selected the requested input.

Bound route-configuration handling to the synchronous AVAudioSession activation
and preferred-input operation. The existing driver permits setup notifications
only before arming. Selection still must resolve to exactly the requested port,
and is verified again before tap installation and before/after engine start.
All route changes after arming remain terminal; other interruptions remain
terminal during setup too. The configuration scope closes on every thrown error.

Reuse AVFoundation, the existing driver callback gate and stop/release path.
Tests reproduce activation notifications over repeated pause/resume and preserve
failed-selection, late route-change, active route-change and interruption behavior.
Compile the actual iPhone adapter; then repeat the physical microphone and resume
checks. A synthetic mock/compile pass alone does not establish live signal input.

Release through a same-identity native update, preserving keys and recordings.
Recovery is the prior compatible native package with a higher build number;
never uninstall or reset data. Mac capture is not changed. No cloud deployment.
