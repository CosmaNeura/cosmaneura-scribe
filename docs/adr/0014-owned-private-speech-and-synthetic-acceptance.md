# ADR 0014: Own private Speech and gate activation on pinned synthetic acceptance

**Status:** Accepted

## Decision

Scribe owns one dedicated Azure AI Speech account per environment. OpenTofu creates an S0
`SpeechServices` account with its custom subdomain, local/key authentication disabled, public
network access disabled, and a network ACL whose default action is `Deny` with no bypass or IP
rules. The account is reachable only through an `account` private endpoint in the Scribe private
endpoint subnet and the Scribe-linked `privatelink.cognitiveservices.azure.com` zone. The only
diagnostic categories sent to the existing Log Analytics workspace are `Audit`,
`ManagedNetworkEvent`, and `AllMetrics`. Request/response and trace categories are deliberately
excluded because they can include clinical content or wire payloads.

Foundation creation, smoke-job creation, and smoke execution are three independent controls:

```hcl
deploy_private_speech_foundation = false
deploy_speech_smoke_job          = false
enable_speech_smoke_job          = false
```

The manual smoke job has no ingress, schedule, event trigger, arguments, or platform retry. Its
dedicated identity receives ACR pull when the dormant job is created and Cognitive Services Speech
User on only the owned account when execution is enabled. No API key is created or accepted. The
runner checks its raw enable variable before Settings, fixture reads, DNS, credentials, or clients,
and exits nonzero while disabled.

Both the smoke and production transcription jobs receive the owned account endpoint and its
private endpoint IP as a single `/32` allowlist. Immediately before every Speech request, the
shared guard resolves the custom hostname and requires every answer to be an RFC 1918 address equal
to that private endpoint. Empty, public, mixed, malformed, or out-of-VNet answers fail with one
fixed error before Speech egress. The account's public-access denial remains a second boundary.

The smoke runner has no caller-supplied path. Its image contains exactly two staged, synthetic,
de-identified PCM16 mono 16 kHz WAV cases and their references. The staged manifest is the
provenance authority: both cases declare `source_kind = synthetic`, `deidentified = true`, and a
verified synthetic consent record. The runner pins and verifies every approved file before client
construction:

| File | SHA-256 |
| --- | --- |
| `manifest.json` | `a79b2aa7451da5076bb1b24f35c0f507b221005943fccd6d1ab6b0ee699d485f` |
| `audio/sample-001.wav` | `8a168578a339d94bf7e87f73e56783df34b7886a2032101e0fab3162d512086e` |
| `audio/sample-002.wav` | `bc679381a7424ffc6a413043abfba67dad3229bf5fde3c15dc5b18c7948c3073` |
| `references/sample-001.txt` | `9ac348ddbf3d21359887ce3553a36b884fa1082198d4a344c51e6be6c60b6e78` |
| `references/sample-002.txt` | `ea85fd711541aa144c0caa7f457bc04315467ba74e1eb233998358ad34deaff6` |

AIFF intermediates, diagnostic scripts, and prior result files are excluded. Success requires both
case IDs, the Azure provider, recognized segments, positive duration, and per-case word error rate
no greater than 0.25. The process emits only fixed structured actions, fixed error classes, and
aggregate duration; it never logs paths, endpoints, reference text, recognized text, or DNS
answers. Results are not persisted by the job.

The transcription job no longer accepts a free-form Speech endpoint or resource ID. Its enable
gate requires the Terraform-owned private foundation, and its Speech User assignment and endpoint
are derived directly from that resource. A successful smoke execution is an operator-enforced
promotion prerequisite before `enable_transcription_job` is changed.

## Consequences

- A reviewed foundation apply creates a paid S0 account, private endpoint, DNS zone/link, and
  limited diagnostics, but neither job can call it while its execution flag is false.
- The committed tests prove configuration, fixture integrity, fail-closed DNS behavior, and the
  runner boundary. They do not prove Azure wire compatibility. That evidence exists only after an
  approved private-network apply and successful manual smoke execution.
- Rotating the private endpoint IP updates both job revisions. Changing any fixture requires a new
  decision, new pinned hashes, and review of its synthetic provenance.
- Operators must use `docs/SPEECH_PRIVATE_ACCEPTANCE.md`; Terraform grants no identity permission
  to start either manual job.
