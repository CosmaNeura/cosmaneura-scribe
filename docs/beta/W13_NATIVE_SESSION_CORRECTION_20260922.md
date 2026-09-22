# W13 native-session correction — exact activation review

**Prepared and development signed; not installed or activated.** This is a
Tier 2 authentication change for the existing private synthetic iPhone catalog.
Build 3 and the original receiver remain active. Authenticated encounter loading
and the full desktop/mobile beta remain incomplete.

## Observed problem and proposed result

The owner reconnected and unlocked the iPhone. The exact build 3 package
installed in place and launched. Their physical Choose an encounter action
reached the pinned private TLS receiver, then both the owner and the Device Hub
view reported `app_binding_missing`. The existing observer maps absent or
JSON-null `azp` to this code after policy rejection. No raw token or claim value
was inspected, and this result does not prove the remaining claims valid.

[Clerk's session-token contract](https://clerk.com/docs/guides/sessions/session-tokens)
allows `azp` to be absent when the originating request has no browser Origin.
The retained native SDK deliberately omits that header; the existing client and
receiver instead require the browser-origin claim. Build 4 permits **absence
only**, explicitly for the native iPhone catalog call. Null, malformed, empty
or wrong `azp` still fails. No Clerk setting or session template changes.

The expected next result is a freshly authenticated catalog containing
**Invented connection visit**. That remains a physical acceptance step, not a
result established by offline tests.

## Exact scope and authorization effect

- `NativeTokenPolicy` and the native coordinator gain a default-false option.
  Only the pinned `getWorkspaceCatalog` bridge operation opts in. The legacy
  renderer token getter and the default policy remain strict. The diagnostic
  observes the new policy, so another failure cannot be mislabeled as the
  missing-origin issue.
- The copied private receiver explicitly selects `w13-ios-native-session-v1`.
  Its verifier permits missing `azp` only when configured for the exact iOS
  origin alone. Desktop/browser origins are excluded from this receiver.
  The original verifier defaults remain strict.
- Native issuer, audience, user/session/organization continuity, expiry and
  cancellation checks remain. The receiver still verifies the actual RSA
  signature/JWKS, issuer, audience, timestamps and current active creator,
  organization and Box binding. Present-but-invalid origin claims still fail.
- The removed check is browser-origin binding for absent-origin tokens at this
  endpoint. An HTTP Origin check is not app/device attestation. Authority here
  depends on the signed token and current creator binding; this packet does not
  establish a production mobile identity boundary or revocation acceptance.
- The same private endpoint, TLS certificate/pin, existing database and invented
  visit are reused. Only GET connection/catalog routes exist. There is no
  capture, clinical write, Core route, account change or new dependency.
- The same bundle/team, SDK, Keychain configuration and web interface are
  preserved. The approved Mac R2 is untouched. No Core/OS checkout or protected
  Scribe authentication file is edited; changes are composed in an owned copy.

## Reviewable package and checks

Owned directory:
`/Users/jw/Desktop/Cosmas/scribe-w13-native-session-20260922.6ass20w_`

| Artifact | SHA-256 |
| --- | --- |
| `export/App.ipa` — version 1.0/build 4, minimum iOS 17 | `ff0b8a41713ca31f6d5d0615a27d02896fae43c6619875c4762e78e4f8aa35bd` |
| Exported web entry — identical to verified build 3 | `e503f130c5173ab0ea49b10c60920d976f8940813715e866d466177f8c39ea2f` |
| `candidate-manifest.json` — source, package and evidence hashes | `4d51c92099fbc703b7400979b48d2b511c35b436bec471dcbf3ee8421f43f7ba` |

`review.diff` contains the exact seven source changes. `change-review.json`
records their before/after hashes. `source-preservation.json` establishes that
329 of 334 iPhone source files are unchanged; only the four named native files
and build number differ. `source-reproduction.json` confirms 348 prepared source
files match a second preparation. This is source reproduction, not reproducible
signed-distribution evidence.

Passed:

- **32 native tests**: the original 28 plus four focused checks for the opt-in
  rule, other required claims, coordinator identity continuity and diagnostics.
  `native-tests-r2.log` records the final source check.
- Actual copied receiver with offline RSA keys and the existing private
  synthetic database, read-only: absent/correct-origin tokens load the invented
  catalog; **24 invalid signed-token cases** are rejected. Strict defaults,
  disallowed origins/Host, missing auth, actor headers, writes, queries and
  no-store behavior pass. `receiver-tests-r2.log` records the result.
- Signed archive/export and deep/strict exported-app signature verification.
  Entitlements are identical to build 3. Existing cached development signing
  inputs were used; there was no distribution upload or registration.
- Python lint/format checks. The exported web entry is byte-identical to the
  already verified build 3 entry, so its behavior tests were not repeated.

The first receiver check failed its expected-success assertion inside the
restricted sandbox; its log remains preserved. The same unchanged check passed
with access to the existing private database socket. The initial package/logs
are also retained; the final archive is `W13-native-session-r2.xcarchive`.
No real token, microphone, Speech, translation or note-generation trial ran.

## Activation and recovery flight plan

Owner approval is required for the exact rule above. Existing launch and local
Core approvals remain valid for their scopes. This packet applies the repository
[Ask first rule](../../AGENTS.md): “Changes to auth/session, consent, transcript
storage, PHI boundaries, CI/deployment workflows, environment configuration, or
production data.” The requested new decision is the absent-origin native rule
and its private receiver activation.

After approval:

1. Verify the candidate manifest and fresh device connection. Verify the owned
   original receiver's executable, working directory and listener; last observed
   PID 97451 listens on `192.168.1.36:8446`. Verify the original private PostgreSQL
   PID 94522. Never act on a remembered PID without rechecking it.
2. Stop only that owned receiver and start the candidate `server.py` using the
   existing Python environment, endpoint, database socket and TLS files from
   `scribe-w13-private-20260922.WDvYrR`. Do not reseed or restart PostgreSQL.
   New fixed-stage logs belong to the candidate directory.
3. Install the exact build 4 IPA in place; verify the installed build, then
   launch through Device Hub. Preserve app data, identity and Keychain state.
4. Perform one physical Choose an encounter action. Require both a new
   `authenticated_catalog_returned` stage and the visible invented encounter
   before marking the first gate passed. Diagnose any further failure with fixed
   codes. Do not conflate catalog access with complete provider-host acceptance.

If the correction fails or must be withdrawn, stop only the verified candidate
receiver and restart the preserved original `server.py` with the same database
and TLS files. Its strict policy again rejects absent-origin tokens, including
requests from build 4. No data/schema rollback or Keychain operation is needed.
The original build 3 IPA remains retained for a separately verified in-place
client recovery if necessary; do not uninstall/reset the app to force a downgrade.

Preserve other apps, simulators, demos 8125/8195 and foreign checkout changes.
No other task is contacted. No push, PR, merge, cloud deployment, shared database,
cohort or PHI use is included. Following catalog acceptance, continue the owner's
exclusive milestones from [the private connection checkpoint](W13_PRIVATE_CONNECTION_20260922.md).
