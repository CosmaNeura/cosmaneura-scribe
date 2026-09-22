# Scribe receiver/native continuation — 2026-09-22

Parent: `e18011580f3fe5aa0b5a044a5da55c73584ad48c`, continuing
`b05dffec7a8bcfa4775c3a0b2b7e3ffc24852d11` on the existing checkout/branch.
The full goal in `SCRIBE_HANDOFF_20260922.md` remains active and incomplete.
This checkpoint follows `SCRIBE_CORE_FACTORY_CHECKPOINT_20260922.md`.

## Verified progress

The mobile provider receiver's recorder setup expected a session ID in the Core
capabilities response. The actual schema has none; the original fixture had
invented it. A corrected schema fixture reproduced the HTTP 422. Recorder setup
now uses the existing configured creator-review read, checks its schema version
and exact session, and returns only the native revision/session IDs. It starts no
recording and supplies no desktop start authority.

Twenty focused receiver tests pass, using twelve unchanged copied identity files,
the actual retained verifier/seven-table schema, an offline RSA key, explicit Core
wire fixtures and the actual TypeScript client. Created/capturing/uploaded scope,
wrong session, Core denial, unsupported schema and revocation during the final
reply are checked. Ruff and receiver typecheck pass. The new socket-only cluster
at `/Users/jw/Desktop/Cosmas/scribe-provider-receiver-20260922.z4ahzgk8/` is stopped.
Logs retain initial environment/setup failures and the reproduced defect apart
from final passing results. See the ADR 0051 amendment.

`MacProviderPresentation.swift` adds disabled native Chrome/Zoom window choice and
menu-bar/persistent recording presentation. It scopes cancellation and UI callbacks
to the active request/resources, discloses application-wide audio limits, and
retains unconfirmed-stop presentation until trusted shutdown. All library sources
typecheck with Swift 6/warnings-as-errors targeting macOS 14.2. No GUI, permission
prompt, native stream, helper rebuild or installed application was exercised.
Native IPC, actual visibility and physical acceptance remain open (ADR 0063).

The desktop grant's relationship to the Scribe capture lease is unresolved. The
current mount grant is requested before flow preparation issues that lease. The
design packet records the conditional ordering change and durable exclusion/
replay requirements; it does not assume the two leases are equivalent. No new
server auth route, schema, grant, capability or client call-order change is applied.
Read `beta/SCRIBE_DESKTOP_START_AUTHORITY_DESIGN_20260922.md` before that work.

## Preservation and remaining work

`build/native-presentation-20260922/checkpoint.json` binds this increment's final
commit, source/evidence hashes and exact compiler command. Core HEAD and all 82
pre-existing dirty paths/statuses/hashes match the prior manifest. All 26 prior
native/protected/dependency inputs, the Electron patch and qualified W13 identity
source are unchanged. No Core/OS edit, installed app or retained service change,
task/agent contact, cloud/shared-data write, push, PR or deployment occurred.
Completed W13/native-TLS/audio-helper/Speech/translation trials were not repeated.

The two already presented decisions—isolated iOS bundle/build preparation and
Electron 44.4.3 dependency/local install—remain unanswered and unapplied. Do not
infer approval or repeat their questions. Neither authorizes a new desktop
backend authority, standalone native custody profile or Core staging identity.

The Core release packet still governs source/schema/configuration preparation,
issuer/account/workload correspondence, a separate phone-reachable receiver,
upload/Core creation/navigation and the retained-source dashboard concern.
The packaged `standalone/provider-host.mjs` is still missing its actual native
auth/custody/presentation/backend profile. Complete those under their exact
approved scope, then qualify installed desktop/mobile identity, physical capture
and recovery, bilingual fidelity through Core SOAP, and signed distribution/
operating acceptance. Local fixtures and typechecks close none of those gates.
