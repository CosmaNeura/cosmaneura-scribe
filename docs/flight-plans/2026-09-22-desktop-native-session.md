# Desktop native session compatibility

Tier 2 identity change, prepared separately and not adopted or activated. The retained native Clerk driver authenticates its SDK client with Authorization and intentionally omits browser Origin. Its native token policy already accepts absent azp for the proposed staging-personal desktop profile, but the receiver currently rejects that token. A fixture containing app://cosmas in azp did not qualify this native path.

Add a separately named, false-by-default desktop-native-session switch. Permit absent azp only in a dedicated app://cosmas verifier using the exact resolved-emu issuer, Core staging personal-session settings, and no organization/audience. Existing iOS and OS settings remain unchanged. Present null, empty, foreign, or mismatched azp still fails; signature, issuer, expiry, session/subject, reviewed account and current Core authority remain required.

This policy does not attest a signed desktop app or distinguish an iOS/native bearer from another valid personal bearer belonging to the same enrolled user. Origin is caller-supplied and cannot establish that distinction. The authorization boundary remains the verified session, reviewed registry mapping and Core's current tenant/provider/encounter checks. Enabling this switch requires exact identity-policy approval and environment qualification, separately from local source adoption.

Prepare the correction on top of the native receiver packet, a disabled complete image context, and a focused offline verifier check. No new Clerk login, credential read, account creation, live provider trial, schema write, deployment, signing, installation, or activation is included.


September 23 native pipe follow-up: a real short request stalled on the helper's
Foundation fixed-count input read until EOF. The native/main connection now
shares a bounded POSIX frame reader, verified with short, fragmented and combined
requests while stdin stays open. The actual desktop native session checks, pipe
client, backend and encrypted workspace factory now reach the retained synthetic
Core review/note through the receiver/Core/Scribe services. No capture, provider
work or successful earlier trial was replayed. A strict fingerprint check's two
expected read-audit additions were verified separately; clinical/processing and
registry records remain unchanged. The real helper builds from 247 inputs and
is assembled with the unchanged desktop host in a disabled review package.
All owned services are stopped. Exact preimages, recovery, failures, evidence and
limits: [desktop connection checkpoint](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/source-stop-followup/desktop-service-connection/README.md).
This changes desktop pipe I/O only; existing identity/authority policy, iOS and
service artifacts are retained. Installed and staging acceptance remain open.
