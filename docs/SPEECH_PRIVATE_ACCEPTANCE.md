# Private Azure Speech acceptance

This runbook provisions and proves the dedicated Scribe Speech path without activating clinical
transcription. Every flag is false by default. Run plans and applies only from the approved private
infrastructure runner, and keep all state and plan files out of Git.

## 1. Review the private foundation

Set only:

```hcl
deploy_private_speech_foundation = true
deploy_speech_smoke_job          = false
enable_speech_smoke_job          = false
enable_transcription_job         = false
```

Run a refreshed plan. It must add one S0 `SpeechServices` account, one private DNS zone and VNet
link, one `account` private endpoint, and one diagnostic setting. Confirm:

- local authentication and public network access are disabled;
- the ACL is `Deny` with no IP rules, and the ARM result exposes no effective bypass (AzureRM
  rejects the `bypass` field for `SpeechServices`; stop if Azure reports one);
- diagnostics contain only `Audit`, `ManagedNetworkEvent`, and `AllMetrics`;
- the plan has no replacement or destroy; and
- neither a smoke identity nor a Speech User assignment exists yet.

Apply only that reviewed plan. From inside the Scribe VNet, resolve the account's custom hostname
and confirm it returns the private endpoint address. Do not paste the hostname or address into
application logs.

## 2. Deploy the dormant smoke job

Build the exact candidate commit into ACR under its lowercase 40-character commit SHA. Set that
immutable `container_image_tag` and:

```hcl
deploy_speech_smoke_job = true
enable_speech_smoke_job = false
```

The plan must add only the smoke identity, its ACR pull assignment, and the manual Container Apps
Job. It must not add Cognitive Services Speech User. Apply, then start the dormant job once. A
nonzero exit with fixed `speech_smoke_disabled` metadata is the expected fail-closed result.

## 3. Enable and execute synthetic acceptance

Set `enable_speech_smoke_job = true`. The plan must add exactly the account-scoped Cognitive
Services Speech User assignment and update the job's raw gate plus owned endpoint/private-IP
settings. After apply and RBAC propagation, start the job without command, argument, image, or
environment overrides:

```bash
az containerapp job start \
  --resource-group <scribe-resource-group> \
  --name <speech-smoke-job-name>
```

Acceptance requires a successful single execution and the fixed `speech_smoke.completed` event.
The two cases must each remain at or below 0.25 WER. No transcript, reference, endpoint, path, or
DNS answer may appear in Container Apps or Log Analytics output.

If the job fails, leave `enable_transcription_job = false`. Distinguish fixed failure classes:

- `speech_smoke_fixture_invalid`: candidate image does not contain the reviewed bundle;
- `speech_private_endpoint_unavailable`: DNS did not resolve exclusively to the Terraform private
  endpoint;
- `speech_smoke_acceptance_failed`: the complete live result missed an acceptance invariant; or
- `speech_smoke_execution_failed`: credential, RBAC, SDK, service, or another opaque execution
  failure requiring Azure-side metadata investigation.

## 4. Promote or roll back

Record the candidate image SHA, execution name, UTC time, and pass/fail state in the approved
change record; do not copy recognized text. Only after a pass may a separate plan set
`enable_transcription_job = true` with its existing PostgreSQL, Blob, and Key Vault prerequisites.

To remove Speech call authority, set `enable_speech_smoke_job = false` and apply. This restores the
raw gate and removes Speech User while retaining the inspectable dormant job. Removing the job or
foundation requires a separate reviewed plan; the Speech account is protected from accidental
destroy.
