# Production native auth storage isolation

Tier 2: native auth/session and production identity boundary. Source-only work;
production remains disabled. Based on reviewed PR516 head 8cee4e57; its existing
artifacts and receipts remain unchanged historical evidence.

Outcome: production's normal Clerk SDK bootstrap cannot hydrate the staging
legacy cache or process the staging owner's pending clear journal. Staging keeps
its existing storage names; production recovery remains enabled in its own scope.

Sequence:

1. Independently review the small owned SDK patch, original/output pins, maintained
   zero-fuzz assembly, production-only driver selection and focused regressions.
2. Merge after required local evidence and durable independent review.
3. Assemble and compile the changed native source afresh. Bind genuine helper,
   bundle, signature and source inventories; do not relabel previous receipts.
4. Perform the separately admitted normal production hosted sign-in and obtain
   the real default session token. Qualify actual audience/native-party bindings
   and preservation of prior staging state before signing final clients.

No live configuration, credential, Keychain journal, auth flow, recording, patient
data, device, Apple submission or production activation is changed here. No SDK
upgrade, dependency install, new app identity or entitlement is included.

Focused checks use pure configuration and isolated in-memory stores only. Synthetic
storage markers are not genuine sessions, production receipts or canary evidence.

Recovery: disable production native configuration if necessary, retaining both
storage namespaces. No migration or store deletion is a recovery step.

Observability: sanitized bounded observer facts only. Normal SDK secure storage is
expected. `.error` logging suppresses routine request/body logs but does not disable
forced SDK error logs; the logger callback cannot suppress unified logging. Raw
SDK output must not be retained during a real auth flow. Separate logging review
and genuine runtime qualification remain open.
