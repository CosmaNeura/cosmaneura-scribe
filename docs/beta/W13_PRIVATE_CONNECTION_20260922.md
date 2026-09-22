# W13 private connection checkpoint — 2026-09-22

The owner's continuation of the proposed private connection repair, followed by
the explicit first priority “Phone-reachable private backend and successful
authenticated encounter loading,” authorizes this bounded local packet. This
supersedes the preceding document's **proposed, not activated** status. The full
beta is still incomplete. No broader cloud, cohort, PHI or release authority is
inferred.

## Current artifact and runtime

The existing Scribe checkout and `codex/beta-preintegration-20260904` branch were
clean at `4682a0b` before this increment. The new owned runtime is:

`/Users/jw/Desktop/Cosmas/scribe-w13-private-20260922.WDvYrR`

- Private HTTPS: `https://192.168.1.36:8446`, bound only to this Mac's LAN address.
  No public tunnel or system trust change. The exact certificate is bundled and
  pinned in W13; native trust evaluation still checks the certificate chain,
  hostname and validity. The certificate expires **2026-09-29 11:27:58 UTC**.
- Leaf SHA-256:
  `9105d19dade486fbb963de1477f74f59ee8247cf3e35898b6d52a2d0dfa39721`.
- New PostgreSQL 16 cluster `pg/`, database `w13_connection_test`, private
  `socket/` at port 55462 and `listen_addresses=''`. Six existing model tables
  contain the reviewed Tester binding and one **Invented connection visit**.
  This is new synthetic data; no lost historical database was reconstructed.
- The receiver freezes 12 existing CosmasOS source files with hashes in
  `runtime.json`. It reuses the original Clerk verifier, creator authentication
  and catalog implementation. Issuer, audience, organization and native origins
  are unchanged. The exact existing Tester membership was checked read-only in
  the W13 Clerk instance before binding; no account or membership was created.
- Only `GET /connection` and authenticated `GET /workspaces` are available.
  Unknown paths, queries, writes and unapproved Host/Origin values are rejected.
  There are no capture, Speech, translation, note-generation or Core routes.
- Logs contain fixed stage names and UTC times only. Tokens, identity values,
  request headers, request bodies and response content are excluded.

W13 **1.0/build 2** was built, development signed, exported and installed as an
update of `com.cosmasos.synthetic.w13` on the owner's physical iPhone 12. A scoped
device query confirms build 2. The existing app was not uninstalled or reset.

| Artifact | SHA-256 |
| --- | --- |
| `export/App.ipa` | `1bd95a992719328c5291d089b5185ff0077d4d83ecf6664e57e1aed95a14dd35` |
| Exported `public/assets/index-BOeSnvhj.js` | `30843efec54156082b8a90b16abbea12038f506a6a3246ed116a9a32a2a41229` |

The original native authentication Swift sources are byte-identical; their
hashes are in `native-auth-preserved.json`. A new bridge method obtains the
catalog through the pinned native connection and retains its bearer token in
native code. Revision checks reject stale results after logout or identity
change. This method performs a TLS health check before asking for a token.
The prepared error/retry correction is included. The old inactive transport
remains in the retained bundle; this packet replaces only catalog loading.

Minimum iOS remains **17.0**. The attached phone runs iOS 27.0, which does not
qualify iOS 17 runtime behavior. Existing cached signing/profile inputs were
used; no distribution upload, registration or provisioning change occurred.
The approved Mac R2 app and its Keychain identity are unchanged.

## Acceptance evidence and current gate

Passed:

- Actual frozen verifier/catalog with offline signed JWT fixtures against the
  new database: accepted reviewed binding; rejected missing/expired JWT,
  unprovisioned subject, wrong organization/origin, unknown routes and writes.
- The actual Swift transport against the running TLS receiver: valid chain,
  hostname and exact pin accepted; wrong pin and loopback configuration rejected.
  The task-level URLSession trust callback was required and is included.
- Original retained and corrected web behavior, including the **exact exported
  app asset**: persistent error, explicit retry, polling, timeout, logout and
  stale response rejection. Private catalog loading never requests a renderer
  token or renderer HTTP call in these fixtures.
- Unsigned build, signed archive, development export, deep/strict exported-app
  signature validation and successful in-place installation; Python/JS lint.

Observed on the phone: build 2 launches to the existing signed-in welcome with
“Sign out.” After the owner's physical **Choose an encounter** taps, the receiver
recorded two new `private_tls_request_received` stages at **12:02:50 and 12:03:00
UTC on September 22**. No local TLS check was running. The owner then reported
**“Secure session is unavailable.”** This establishes phone-to-private-backend
TLS reachability, but token acquisition/validation fails before the authenticated
catalog call. No `authenticated_catalog_returned` or other catalog result has
been observed. The build 3 result below now identifies the native
application-origin check.

Do not report authenticated encounter loading as passed until the fixed
`authenticated_catalog_returned` stage and visible invented encounter establish
it. `device-trial-start.json` records **two pre-device local TLS requests**;
those must not be counted as phone traffic. `candidate-manifest.json` records the
pre-install package; `iphone-update-result.json` and
`iphone-app-after-update.json` record actual installation/build confirmation.
`installed-checkpoint.json` binds those receipts, the exported package and actual
composed sources by SHA-256. At that readback, receiver PID **97451** and private
PostgreSQL PID **94522** matched their expected executables; recheck before use.

## Installed session diagnostic — build 3

Prepared in a separate owned artifact directory (same checkout and branch):

`/Users/jw/Desktop/Cosmas/scribe-w13-session-20260922.ZR3yR7`

Build 3 adds a wrapper around the existing native driver's single fresh-token
request. It returns the original token or error unchanged, observes the original
policy's result, and retains only an allowlisted failure category. No token,
claim value or SDK error detail is logged or sent to the renderer. The original
seven native authentication sources and account/endpoint configuration remain
unchanged. The existing coordinator still enforces every authorization check.

The fixed category remains visible through unavailable/ready transitions, so
the next physical attempt can distinguish request failure, empty token, identity
change, policy rejection and a missing/mismatched application-origin claim.
These categories are diagnostic evidence, not permission to relax policy; a
missing-origin category does not establish that all other claims are valid.

| Artifact | SHA-256 |
| --- | --- |
| `export/App.ipa` | `a7f4d1298f2c5929b898aad622ae49d3774702bf4ad1e27345fbf00b59dcf8a0` |
| Exported `public/assets/index-BOeSnvhj.js` | `e503f130c5173ab0ea49b10c60920d976f8940813715e866d466177f8c39ea2f` |

Offline Swift checks establish unchanged driver result/error behavior and
continued policy rejection. The exact exported web asset passes fixed-category
persistence, private transport, retry, logout and stale-result checks. Archive,
development export and deep/strict signature verification pass. The first web
check's fixture-timing failure is preserved separately; the corrected fixture
waits for the native result before asserting. No live Speech/translation trial
was repeated.

**Build 3 is installed and was launched.** After the owner reconnected and
unlocked the iPhone, the exact previously signed package installed in place.
`iphone-update-owner-ready.json` records success and
`iphone-app-owner-ready.json` confirms version 1.0/build 3. The earlier failed
4016 receipt remains preserved separately. The native app showed the existing
signed-in welcome and Sign out action.

After the owner's physical tap, both their report and the Device Hub phone view
showed **“Private connection succeeded, but session verification failed
(app_binding_missing). Your workspace remains closed.”** The receiver recorded
new TLS stages at **12:52:10, 12:52:20 and 12:53:05 UTC** on September 22; no
local TLS test was running. No authenticated catalog result was recorded.
`installed-session-failure-checkpoint.json` binds this observation to the
installation evidence. The code means an absent or JSON-null `azp` during an
already-rejected token check; it does not establish the validity of other claims.

Read-only contract review: [Clerk session-token documentation](https://clerk.com/docs/guides/sessions/session-tokens)
states that `azp` comes from the original Frontend API `Origin` and can be absent.
The retained native SDK middleware deliberately omits `Origin`, while the
retained client and receiver require the configured `azp`. The observed code
confirms this check blocks the current native request. It does not yet establish
successful authentication under a corrected policy. No Clerk setting, template
or running receiver authentication policy changed.

The signed **build 4 candidate and private iPhone receiver correction** are
prepared, tested and awaiting approval of the specific authentication-rule
change. See [the exact review and activation packet](W13_NATIVE_SESSION_CORRECTION_20260922.md).
Build 3 and the original receiver remain active; do not activate the proposal
solely because an earlier launch was approved.

## Resume safely

1. Read current `server-stages.jsonl` and physical W13 UI. A new
   `private_tls_request_received` establishes the phone's connection only when
   no local test is running. `authenticated_catalog_returned` plus the visible
   invented encounter establishes the first end-to-end gate. Diagnose failures
   through fixed codes; never print tokens. Apply the prepared native-session
   rule only after approval of its exact scope.
2. Preserve the running receiver and private database. Verify their executable,
   listener and owned directory before restarting or stopping anything. Do not
   rerun seeding, replace the certificate, rebuild Mac R2 or replay completed
   Speech/translation trials. If the LAN address changes or the certificate
   expires, the exact app/endpoint binding needs a new reviewed candidate.
3. After this gate, the owner's exclusive remaining focus is complete standalone
   desktop/mobile provider hosts; native refresh/logout/revocation/identity
   continuity; physical capture/interruption/offline/iOS 17/Meet+Zoom acceptance;
   fidelity through existing Core SOAP; signed installation/update/rollback,
   onboarding and operating acceptance. The local provider workflow at
   `abea802b0d3c66e5945d74024ee1ecd5c3a8f899` remains reusable and is not yet wired
   into this read-only connection candidate.

No other tasks were contacted. Core and CosmasOS checkouts were read-only;
foreign changes, demos 8125/8195, other apps and simulators remain protected.
No shared database, running auth policy, credential namespace, ACL or system Keychain
setting was changed. No push, PR, merge, cloud action or completed live-service
trial was performed.
