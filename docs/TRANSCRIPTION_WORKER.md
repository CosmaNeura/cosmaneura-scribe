# Transcription worker

The worker turns one uploaded, consented capture session into one durable transcript. Its first
trigger is a manual Azure Container Apps Job. The job definition and activation are separate and
both are false by default; there is no public route, schedule, queue trigger, or ingress.

## Processing sequence

1. Lock the tenant-scoped session and return the existing transcript on replay.
2. Validate the persisted consent record against the session before reading any audio metadata.
3. Claim a PostgreSQL transcription-job lease and move `uploaded` to `processing` atomically.
4. Pass ordered encrypted chunk metadata to the replaceable audio assembler.
5. Renew the owned lease periodically throughout assembly and speech-to-text. A failed renewal
   cancels in-flight provider work before it can be persisted.
6. Revalidate consent after assembly and immediately before speech-to-text.
7. Preserve provider speaker IDs and prefix them with the capture channel. For virtual visits,
   separate microphone and system audio supply clinician/patient role priors; in-person, phone, and
   mixed audio remain `unknown` for later review.
8. Apply metadata-only duration, segment-count, ordering, and timestamp quality gates.
9. Revalidate consent, verify lease ownership, persist the transcript, complete the job, move the
   session to `transcript_ready`, and write a metadata-only audit event in one transaction.

Failures expose only fixed codes. Ordinary provider or assembly failures become `retryable` until
the configured maximum attempt count; consent and quality failures are terminal. An active lease
prevents concurrent duplicate transcription, while an expired lease may be reclaimed after a
worker crash. Heartbeat renewal keeps slow provider calls owned; if renewal fails, the worker
cancels its assembly/provider task and cannot persist. Transcript replay avoids a second provider
call.

## Implemented assembly boundary

`EncryptedBlobAudioTrackAssembler`:

- uses managed identity and private Blob connectivity;
- downloads only object IDs registered to the tenant/session lease;
- verifies ciphertext size and SHA-256 metadata before decryption;
- unwraps one immutable client-generated session DEK through Key Vault `unwrapkey`;
- assembles ordered channel tracks in encrypted ephemeral storage;
- returns no blob URL, object path, transcript, or patient value in logs or errors; and
- securely cleans temporary material when its async context exits.

The Container Apps Job mounts an Azure platform-encrypted `EmptyDir`; assembled track files remain
application-encrypted inside it. The runner constructs the production repository, assembler, and
Speech adapter only after its raw enable gate and exactly two positional tenant/session UUIDs
validate. It closes all three clients and invokes cancellation-shielded assembly cleanup on every
exit path, including SIGTERM and SIGINT.

The assembly plaintext limit is 64 MiB in aggregate across channels, not per track. For PCM16 mono
16 kHz input, that is about 35 minutes of one-channel audio or about 17 minutes of a two-channel
virtual visit. The job intentionally keeps the 64-MiB default while it has 1 GiB of memory. Before
any pilot, the acceptance run must prove that the pilot's maximum supported visit duration fits the
aggregate ceiling; raising it requires a reviewed memory or streaming change.

## Deployment and activation

The controls are deliberately staged:

```hcl
deploy_transcription_job = false
enable_transcription_job = false
```

1. Provision and bootstrap PostgreSQL, switch the API to it, and build an image tagged with the
   exact lowercase 40-character commit SHA.
2. Keep `deploy_database_migration_job = true`, set `deploy_transcription_job = true`, keep
   `enable_transcription_job = false`, and apply.
   This creates the dedicated identity, its ACR pull role, and the dormant manual job. Re-run the
   database migration job so bootstrap maps that identity to the narrow transcription database
   role. A disabled execution fails with a fixed nonzero exit before parsing targets or constructing
   clients. Run bootstrap only in a drained maintenance window with no API traffic or transcription
   execution: bootstrap revokes current application privileges before granting the reviewed sets,
   and PostgreSQL checks privileges per statement.
3. Separately provision private Azure AI Speech, private DNS, and the synthetic acceptance path.
4. Set the reviewed Speech endpoint/resource ID and `enable_transcription_job = true`. The plan
   must add only the job revision plus Blob Reader, key-scoped Crypto User, and Speech User roles.
   Apply only after reviewing those scopes. Azure data-plane role assignments are eventually
   consistent; wait for all three assignments to appear for the worker identity and propagate
   before the first execution. Treat an initial `403` as propagation delay and never widen a role
   to bypass it. This repository grants no identity permission to start a job execution.
5. Start one target through an approved operator's existing ARM access. Do not override the enable
   flag at execution time:

   ```bash
   az containerapp job start \
     --resource-group <scribe-resource-group> \
     --name <transcription-job-name> \
     --container-name worker \
     --args <tenant-uuid> <session-uuid>
   ```

The template has parallelism one, completion count one, and zero Container Apps retries. A
retryable durable record is retried by manually starting the same tenant/session again; the worker
enforces a maximum of three database-recorded attempts. Never start concurrent executions for the
same session.

To deactivate, set `enable_transcription_job = false` and apply. That restores the raw fail gate
and removes all three worker data-plane assignments while retaining the inspectable job and ACR
pull role. Stop any execution already in progress separately before relying on that rollback.
