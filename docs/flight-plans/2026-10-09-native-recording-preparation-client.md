# Native recording preparation client

Tier 2. The native recording factory currently reads Core context, then the
public encryption key. When the verified Core-owned mount advertises
`native_recording_preparation_v1`, request the combined context/key read.
Older mounts retain the original context/key path. Uncertain responses fail;
there is no automatic server retry or inferred permission.

Keep the response inside native code. Validate the original scope/nonce/status/
freshness envelope, admitted Scribe namespace, exact public-key fields and RSA
3072 modulus. Return only the existing acknowledgement to the renderer. Keep
the original single-use context ticket and at most five seconds of monotonic
reuse within the server's 30-second freshness bound. Native service consumes
the public key once; expiry or SDK revision changes use the original fresh key
read. Account changes reject it. No key journal, captured PCM, lease, reservation
or source-start contract changes. Native consent/source checks remain required.

Core PR733 and receiver PR297 must deploy before releasing this native consumer.
Recovery uses the previous app/receiver and preserves all keys, recordings and
version-one journals. No migration, dependency, permission prompt, cohort or
physical-audio activation. Validate original native transport/context tests,
combined malformed/revoked/stale receipts, capability compatibility, single-use
key, expiry, SDK/account changes, lost window reply and fictional PCM encryption
with actual native owners. Compile for macOS/iOS; use virtual audio only.

Record exact final tested commit, implementer review and local results in the
PR. Work removed is not a measured phone startup result; 5–7 second acceptance
still requires a matched staged backend/client and complete consent-to-Ready
measurements.
