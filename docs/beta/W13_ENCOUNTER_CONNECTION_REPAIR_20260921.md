# W13 encounter connection repair — 2026-09-21

The physical phone is running a W13 authentication qualification package whose
workspace API is compiled as `http://127.0.0.1:8046`. That is the phone's own
loopback address, not this Mac. The old local server/runtime is absent. A successful
native sign-in does not make this endpoint reachable or qualify workspace access.
The existing offline candidate checker rejects the retained IPA with
`api_origin_not_device_candidate` and `approved_api_origin_missing`.

## Corrected locally

The original retained web asset was exercised directly in an offline DOM with
its bundled React, native session component, encounter UI and request transport.
Only the bootstrap, native adapter and HTTP responses were fixtures. No real
login, token, network request, capture or live-service trial occurred.

The reproduction establishes this error-loss sequence: the native token request
rejects and emits unavailable; a subsequent native state read returns ready with
a new revision; the revision-keyed workspace remounts and loses its error. This
matches a possible path behind the observed phone reset. It **does not establish
why the actual phone's token request failed**, or prove that a token failure caused
that particular observation. The earlier same-state polling hypothesis was ruled
out against the exact retained code: it already suppresses unchanged state, and
its encounter component does not have the newer reference checkout's identity
reset effect. That newer source must not be mistaken for the installed build.

`scripts/w13-workspace-recovery/prepare.mjs` prepares a correction from only the
exact retained entry SHA-256
`900f26844b8b9d134c2a12a00ae9f7cd7a40282ee3a2578b79d85bbbb08408af`:

- Retain a fixed, content-free access failure notice outside the workspace's
  revision boundary. Clear it after a successful fresh token request or explicit
  sign-in/sign-out action. Keep all session/revision checks and private-view closure.
- Keep the request identity stable across unchanged renders, reusing the current
  reference implementation's memoization without editing that checkout.
- Bound encounter catalog reads to 30 seconds and show a connection/retry message.
  Each retry is explicit and requests a fresh token. No mutation/retry policy changes.
- Preserve the native SDK, token policy, Keychain, callbacks and backend address.
  Reject an unknown input hash and require a new output directory.

The correction is a prepared **web asset**, not a signed/installable candidate.
It does not repair the absent phone-reachable backend. The existing iPhone app
and approved Mac R2 binary/session are unchanged.

`recovery.test.mjs` reproduces the original failure, verifies the corrected
failure/retry sequence, checks successful encounter retention through polling,
read timeout and explicit retry, and rejects a token completing after logout.
These checks pass against the full retained/corrected asset. No complete
regression or completed live-service trial was repeated.

## Missing authority: a phone-reachable private test runtime

The preserved handoff allows local runtime integration but explicitly states:
“This does not authorize exposing a live backend.” It also excludes changing
environment/origin configuration by implication. Earlier Core admission/SOAP
and local provider-workflow approvals remain valid; they do not select or expose
an endpoint for the physical phone.

The bounded next packet is:

1. Prepare a new, owned, synthetic-only workspace runtime on this Mac using
   locally copied existing receiver/auth code and a new private Unix-socket
   database. Preserve foreign checkouts, old packages/data and demos 8125/8195.
2. Give only this runtime a private HTTPS listener reachable from the paired
   iPhone. Prepare and record an exact endpoint and certificate binding before
   activation. Use authenticated TLS; no public tunnel, cloud deployment,
   system-wide trust change or TLS verification bypass.
3. Keep the approved Clerk issuer, audience, organization, native origins and
   fresh creator checks. Reuse the original selected Tester binding if retained;
   do not automatically enroll an unknown identity. No credentials in web assets
   or logs and no browser-held Entra workload credential.
4. Configure a new W13 development candidate for that exact private endpoint,
   include this web correction, preserve its bundle identity/iOS 17 floor and
   existing app data, and replace only the W13 installation after package checks.
5. Qualify read-only encounter loading first. Capture, Speech, translation, note
   generation, patient data, cohort activation and distribution remain outside
   this connection repair. Do not repeat completed live-service trials.

This packet is **proposed, not approved or activated**. The exact endpoint,
certificate and resulting native artifact cannot be called qualified yet.
Phone reachability alone will not prove native JWT/API acceptance. If the actual
token fails after connection is available, diagnose it with fixed metadata only;
do not relax the existing token policy to obtain a successful screen.

## Reproduce the local correction

Use the retained Node 24 runtime; provide the already installed jsdom module as
the second argument to the test script. No dependency installation is required.

```text
node --experimental-vm-modules scripts/w13-workspace-recovery/recovery.test.mjs <retained-entry.js> <installed-jsdom/lib/api.js>
node scripts/w13-workspace-recovery/prepare.mjs <retained-entry.js> <new-output-directory>
```

Durable output and the passing test log are in the existing recovery directory,
under `encounter-workspace-correction/` and `encounter-recovery-tests.log`.
The complete beta goal remains open.
