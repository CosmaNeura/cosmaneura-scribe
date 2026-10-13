# Desktop preparation in the admitted reply

Return the existing full desktop preparation metadata from Core's prepared admission so the receiver can remove its separate Core metadata request. Desktop still receives the same creator review, public wrapping key and current capabilities. Native/mobile key custody and recording-start grants remain unchanged.

Risk: Tier 1 additive contract with a reversible, two-service rollout. No migration, dependency, configuration, credential, cohort or production changes. The recording-window request and all current authority, consent, capability and Key Vault checks remain required.

Core adds an optional, closed `include_preparation_metadata: true` field only to prepared admission, mutually exclusive with native metadata. It performs the existing preparation read after consent commits and checks its session against admission before final publication. Core advertises `X-Cosmaneura-Admission-Preparation-Metadata-Version: 1` separately from native metadata support.

The receiver retains only that version capability in the existing single-use, age-bounded mount context. When the existing desktop full-metadata request is opted in and the current context supports it, the receiver requests the combined result and validates its entire existing contract. Missing, malformed, denied, cancelled or uncertain results fail without retrying admission or switching routes. Without negotiated support, the existing separate read is selected before I/O. The desktop UI, durable key/window intents and capability budget calculation do not change.

Deploy the backward-compatible receiver first and Core second. The optimized path remains inactive until Core advertises support in a fresh mount. Review both final source commits independently and qualify exact artifacts with local tests while Actions stays disabled. A new Core staging controller dispatch needs the owner's concrete exception approval under Core's manual-only workflow rule; the earlier exception covered PR751/320 only.

Recovery: restore the prior Core or receiver image/revision. Older Core removes support from new mounts; the receiver follows the existing path. No schema recovery or deletion is needed. Prepared contexts remain single-use and retain their original expiry; no cached access decision is introduced.

Validation must cover exact full metadata equality, one Core request on negotiated support, no opt-in on replay without attestation, mutual exclusion, session mismatch, malformed/private wrapping keys, invalid budget, revocation at every registry fence, cancellation/response loss, expired context, old-Core compatibility, unchanged mobile contracts, and preserved first-window behavior. Measure fresh desktop and mobile starts after deployment; reducing one call alone is not evidence of a one-second saving or of meeting the five-second target.
