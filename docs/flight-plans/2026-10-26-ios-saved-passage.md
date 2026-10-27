# iOS saved passage implementation and qualification

Owner: John Willems. Initial cohort: synthetic staging lab accounts and the
staging Beta client. Review date: November 1, 2026. Production/PHI promotion is
outside this change's acceptance.

Current baseline: Scribe main `922053e981206f5e877ffc7f3fa23348275f9d53`.
Build 2026102616 and phone build 81 do not implement iOS Listen.

1. Add the native encrypted archive and bounded authenticated passage decoder.
   Verify actual RSA/AES, original queue preservation, lost write replies,
   missing historical audio, identity separation, tamper rejection, 30-second
   bounds and cancellation. This library slice alone adds no UI capability.
2. Complete archive retention during native seal/upload recovery. Add fresh
   Core segment authorization, owned native playback and the shared UI
   capability. Verify original queue purge and source/consent rules remain
   intact; current account, workspace, binding, session and segment must match.
3. Independently review the final source and local native/renderer checks.
   Rebuild a new staging native client. Preserve current test apps until a
   reviewed replacement is selected.
4. In the owned lab, record a fresh synthetic visit, Finish, Save, reopen the
   same note, and Listen to a server-selected passage. Verify actual audible
   content, stop/cancellation/account separation and original note/source
   identity. Separately qualify the physical iPhone build.

Acceptance requires all steps. A source test or Desktop Listen cannot substitute
for an actual iOS saved-audio result. Already purged older audio may remain
unavailable, with the transcript retained.

Recovery: disable distribution/activation of the new client and repair forward
from current main. Keep additive sealed archives dormant; do not delete or
rewrite native keys, queue receipts, consent, transcripts or archived audio.
No schema migration, new dependency, server route or production deployment is
part of this implementation.
