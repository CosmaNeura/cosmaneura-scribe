# Native Clerk virtual lane

Builds unchanged, locked 233-file ClerkKit in an owned package using genuine macOS
XCTest, `configureForTesting`, memory Keychain, telemetry off, and no remote dependencies.
Requires Python 3 and Swift 6.2+; run from this folder:

```sh
python3 run.py --mode offline
python3 run.py --mode public
python3 run.py --mode email --bootstrap
```

Offline tests exercise real SDK middleware failures and synthetic client state.
Public mode fetches staging configuration; neither proves account/Core access.
Explicit bootstrap creates/reuses only approved `scribe-lab-a/b+clerk_test@example.com`
users; required cryptorandom passwords remain in memory. OTP `424242` sends no email.
`--bootstrap-domain cosmaneura.com` selects the separately approved Cosmas MD
synthetic accounts. This is identity setup only; normal hosted client sign-in and
legitimate practice enrollment must still be tested separately.
Synthetic user IDs go to `synthetic-accounts.json`; no Core grants are created.
Existing-account `--mode email`/`ticket` needs trusted environment values:
`SCRIBE_LAB_SYNTHETIC_ONLY=1`, `SCRIBE_LAB_USER_A/B_ID`, plus `SCRIBE_LAB_EMAIL_A/B`
or `SCRIBE_LAB_TICKET_A/B`; optional public key must match staging resolved-emu-53.
Tickets are never minted here and bypass original password/MFA/hosted login.
Live tests check two identities, fresh token bindings, offline recovery, and owned sign-out.
No installed-device/cache, recording, or Core signature/membership/workload proof is claimed.
Receipts retain metadata/hashes only; raw child output is discarded. Missing live
configuration fails; unselected live tests skip. Timeouts kill the owned process group.
