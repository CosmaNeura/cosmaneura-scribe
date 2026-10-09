# Native recording preparation receiver

Tier 2. Add the Core-qualified native preparation read to the existing fixed
native transport. It returns the admitted native context and public wrapping
key in one request. Keep the three fresh receiver account checks, workload
token acquisition, no-store envelope validation and original native route.

Reject extra/private key fields, malformed scope, changed account, completed
recording state and caller-selected IDs. Native context and key do not grant
microphone, source or lease permission. No new route, credentials, migration,
dependency or transcript response is introduced. Existing context/key reads
remain supported. Legacy workspace routing remains unchanged.

Core receiver merges first; deploy this additive receiver before releasing the
native consumer. Recovery uses the previous receiver image and previous client
while retaining keys, journals and recordings. Do not enable a client capability
before its paired Core receiver is deployed. Validate fixed transport tests,
existing preparation and public-key tests, source lint/types and unchanged
OpenAPI. Exact tested commit and implementer review belong in the PR evidence.
