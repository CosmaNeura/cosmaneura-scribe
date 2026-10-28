# Exact root execution packet

Use the existing installed Node 24 and Azure Python. Copy the three Python
reader/operator/bound-CLI files together into one owned protected runtime folder;
the operator reads sibling `live-bot-selection.json`. Do not add a public service.

After normal Enable, Start, silent synthetic joins and normal host recording
approval establish the actual tuple, prepare a protected configuration with
exact keys:

```json
{
  "version": 1,
  "expected": {
    "runId": "UUID",
    "collectorSHA256": "SHA256_OF_live-bot-reader.py",
    "startedAtEpochMs": 0,
    "accountIdentitySHA256": "SHA256_OF_ACTUAL_CLERK_SUBJECT",
    "doctorRef": "doctor_TYPEID",
    "patientRefSHA256": "SHA256_OF_ACTUAL_PATIENT_TYPEID",
    "hostIdSHA256": "SHA256_OF_ACTUAL_NORMAL_HOST",
    "meetingRecordRef": "zmtg_TYPEID",
    "meetingIdSHA256": "SHA256_OF_ACTUAL_ZOOM_NUMERIC_ID",
    "appointmentRef": "appointment_TYPEID",
    "occurrenceDigest": "ACTUAL_CONSUMED_OCCURRENCE_HMAC"
  },
  "privateScope": {
    "clerkSubject": "ACTUAL_SYNTHETIC_SUBJECT",
    "meetingId": "ACTUAL_R8_NUMERIC_ID",
    "patientRef": "ACTUAL_PATIENT_TYPEID",
    "botId": "ACTUAL_SERVER_BOUND_BOT",
    "recordingId": "ACTUAL_SERVER_BOUND_RECORDING"
  },
  "deployment": {
    "revision": "CURRENT_READY_WEB_REVISION",
    "runtimeSHA256": "ACTUAL_SORTED_RUNTIME_MANIFEST_SHA256",
    "runtimeFileCount": 451,
    "schema": "3d40e4e90e05",
    "recallKeySHA256": "47e0f1fe83e8ffbc188c9a6c68f5ebac7727e59bc7b832f5c380bf9e14d5bc05"
  }
}
```

The account hash must be the actual verified Clerk subject hash. The private
IDs are supplied only after normal Core creation; they stay in protected config
and private stdin. Compute `configurationSHA256` from the exact bytes
`JSON.stringify({version:1,expected,privateScope,deployment}) + '\n'` that the
maintained JS launcher sends. No arbitrary provider URL is accepted.

The protected sibling selection has these required fields; root fills current
readiness values and hashes the exact files, then reviews it:

```json
{
  "version": 1,
  "status": "APPROVED_OWNED_R8_READ_ONLY_LIVE_COLLECTOR",
  "issuedAt": "UTC_ISO",
  "expiresAt": "UTC_ISO_MAXIMUM_ONE_HOUR_LATER",
  "operatorSHA256": "EXACT_OPERATOR_SHA256",
  "boundCliSHA256": "EXACT_BOUND_CLI_SHA256",
  "configurationSHA256": "EXACT_STDIN_CONFIG_SHA256",
  "webApp": "cosmaneura-staging-app",
  "container": "cosmaneura-staging-app",
  "revision": "CURRENT_READY_WEB_REVISION",
  "replica": "EXACT_READY_REPLICA",
  "image": "sha256:ACTUAL_READY_IMAGE",
  "coreCheckout": "/private/tmp/core-zoom-durable-merged-3d5665a2",
  "coreSource": "3d5665a2a4a5bd99c8b1540a3923887e34ce8c31",
  "workerPath": "ABSOLUTE_OWNED_live-bot-reader.py",
  "workerSHA256": "EXACT_READER_SHA256",
  "ackPath": "/private/tmp/zoom-durable-staging-build-prep-20261028-01/ack_transport.py",
  "ackSHA256": "325acd6cc22bdfc690da4d3a8f92b78666ed46f2f84ad1515375ff74637d5bd2",
  "helperPath": "/private/tmp/core-zoom-durable-merged-3d5665a2/scripts/staging_web_image_only.py",
  "helperSHA256": "df74728bf4377adfa2b3b57e7e7c51e94e719e2c6542d6853fcb3cfb7f03d5f7",
  "boundAzurePath": "/private/tmp/core-zoom-durable-merged-3d5665a2/scripts/staging_azure_cli_bound.py",
  "boundAzureSHA256": "5c4d2fa23b5b5d1c375cd405808e44d653049e20ba682264cd92df903df54a00",
  "transportNonce": "FRESH_32_HEX",
  "publicListener": false,
  "providerMutations": 0,
  "recordMutations": 0
}
```

The normal host action record is protected JSON. Consent has only source,
action, actionId, hostIdSHA256, meetingIdSHA256, occurrenceDigest,
observedAtEpochMs and `files:[{sha256}]`. End additionally has
actionStartedAtEpochMs. The metadata source/action values are the maintained
gate's exact normal UI action values. The action ID and times describe root's
actual action. The binding passed to JS is `{path,sha256,files:[{path,sha256}]}`;
all referenced files must be regular, current-user-owned and mode 0600.

Create the maintained collector with the pinned Python/operator, expected scope,
privateScope, deployment and consentArtifact. It starts the resident stream once.
Pass it to `createBotObservationRelay({expected,collector,signal})`. The existing
loopback endpoint capability is protected and may be forwarded only through the
owned SSH connection into Dublin's loopback. Audio owner receives a protected
endpoint file and the exact same expected scope. No synthetic audio starts until
each initial real proof passes. Preserve the complete original DTO in metadata
receipts; do not replace it with a verified boolean.

After the last fresh recording proof, root performs normal End for all, records
and binds its actual End artifact with `collector.bindNormalEnd(binding)`, then
requests `observeStopped`. A pending canonical release is an unconfirmed stop;
source restart remains blocked while a later exact stopped read can settle.
Finally close the relay and collector and require the remote-close acknowledgment.

No actual staging/provider invocation is part of offline tests or this document.
