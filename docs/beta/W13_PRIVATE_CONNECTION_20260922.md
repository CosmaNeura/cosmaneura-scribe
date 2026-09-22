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
“Sign out.” This is session-restoration evidence, not yet JWT/API acceptance.
No post-install request has reached the receiver at this checkpoint. Device Hub
shows the app, but forwarded swipes/taps have had no effect. The owner was asked
to tap **Choose an encounter** on the physical phone and allow the expected
private local-network connection if prompted. That result is pending.

Do not report phone reachability or authenticated encounter loading as passed
until both the fixed receiver stages and visible invented encounter establish
it. `device-trial-start.json` records **two pre-device local TLS requests**;
those must not be counted as phone traffic. `candidate-manifest.json` records the
pre-install package; `iphone-update-result.json` and
`iphone-app-after-update.json` record actual installation/build confirmation.
`installed-checkpoint.json` binds those receipts, the exported package and actual
composed sources by SHA-256. At that readback, receiver PID **97451** and private
PostgreSQL PID **94522** matched their expected executables; recheck before use.

## Resume safely

1. Read current `server-stages.jsonl` and physical W13 UI. A new
   `private_tls_request_received` establishes the phone's connection only when
   no local test is running. `authenticated_catalog_returned` plus the visible
   invented encounter establishes the first end-to-end gate. Diagnose failures
   through fixed codes; never print tokens or weaken the unchanged auth policy.
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
No shared database, auth policy, credential namespace, ACL or system Keychain
setting was changed. No push, PR, merge, cloud action or completed live-service
trial was performed.
