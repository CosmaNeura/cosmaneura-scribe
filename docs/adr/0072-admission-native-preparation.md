# ADR 0072: return checked native preparation with fresh consent

Accepted for dark fictional staging validation under the recording-start goal.
Adjacent consent and native context requests duplicate device token/transport
work. Compose the existing consent action and existing fresh native preparation
read in a single versioned native admission reply. Both keep their original
server checks. Scope comes from current server admission, never from the device.

The native bridge consumes the bounded namespace/public wrapping key once,
strips it before renderer publication and preserves the original five-second
monotonic expiry. This is preparation metadata, not capture permission. Source
start still obtains a fresh grant. Invalid/uncertain replies fail closed; old
servers use the existing read chosen before I/O. No new retained credential,
background audio, durable cache or dependency is introduced.

See ../flight-plans/2026-10-13-admission-native-preparation.md for release order,
qualification and recovery. Native deployment acceptance remains separate from
synthetic timing, so no device-speed claim follows from these tests alone.
