# Simplified visit entry

Risk: Tier 1, reversible personal staging beta UI. Owner authorization is the all-twelve Scribe UX task and the current feedback about too many screens before Record. Local checks and implementer review substitute for hosted checks under the owner's September 25 agreement.

Selecting an existing patient explicitly creates today's visit and opens its recording setup. The prior separate Create visit & continue confirmation screen is removed. Patient buttons identify the creation action; new-patient creation retains its explicit form confirmation. The existing consent panel and separate desktop Start action remain. Ordinary microphone source details are collapsed with the selected source visible; choosing video opens those details. The primary action states that it prepares recording instead of another generic Continue.

Creation, current encounter authorization, journal recovery, consent state machine, audio capture, encryption and service contracts retain their original sequence. Creation is not added to the consent-to-ready path. Returned patient identity is checked before opening. Double taps use the original busy/idempotency owner. Pending/lost creation recovery never records consent or starts audio.

Release: merge the exact checked/reviewed commit; update only renderer assets in a new signed desktop package based on installed build74, retaining all native helpers, profile, claims, runtime and data. Verify the installed fictional path without starting physical audio. Recover by restoring retained signed build74. No service or production deployment, migration, new dependency or security permission change.

The shared mobile UI source is included; new TestFlight delivery and actual phone timing acceptance remain separately unverified. Existing mobile build63 receives the already-deployed backend latency corrections.
