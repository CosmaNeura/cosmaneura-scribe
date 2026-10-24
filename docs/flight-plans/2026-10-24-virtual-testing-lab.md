# Isolated Scribe virtual testing lab

Tier 2: test-only live authentication tooling. The owner authorized the
recommended virtual test environment on October 24. Product authentication,
consent, entitlements, dependencies and deployed Core remain unchanged.

Use the retained, hash-locked ClerkKit sources in a genuine XCTest target with
in-memory credential storage. Live identities must be dedicated synthetic
staging accounts. Never use the installed application's credential store.
Distinguish SDK authentication from the hosted login UI and Core membership.

Install tooling into an owned output directory with a retained dependency lock.
Keep browser contexts, simulator devices, Docker services and evidence separate
from existing work. Bind service ports to loopback. Audio and workflow fixtures
are invented and consented; reports contain checks, timings and hashes, never
credentials or raw service content. Missing live prerequisites are blocked,
not passed. No paid services, production deployment or GitHub Actions changes.

Validate the harness with positive and deliberately failing examples, then run
available real adapters. Have a non-implementer review the final commit.
Recovery: stop only owned lab processes/containers and shut down the recorded
lab simulator UUID; keep evidence and existing application data. Removing this
test-only directory from a later commit does not require product rollback.
