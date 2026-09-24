# W13 private connection repair

These tools compose the narrowly scoped, synthetic connection candidate described
in [the current checkpoint](../../docs/beta/W13_PRIVATE_CONNECTION_20260922.md).
They do not start a complete Scribe/Core service or create a beta release.

The runtime is outside Git in an owned directory. Preparation requires an empty
directory, an explicitly selected RFC1918 address, the reviewed existing Tester
subject and the local reference checkout. It copies only the listed receiver
files and records their hashes. No source in that reference checkout is edited.

- `prepare_runtime.py` copies the receiver inputs and creates a seven-day
  certificate for one private endpoint. It starts no process. Its CA private key
  is discarded; the TLS server key stays mode 0600 under the mode 0700 root.
- `seed.py` is copied to that root and requires a new, empty database schema.
  Never rerun it against the existing trial. PostgreSQL must use the owned Unix
  socket with `listen_addresses=''`; the server does not need a TCP database.
- `server.py` reuses frozen authentication and catalog code, exposes two fixed
  GET routes and logs only fixed stages. Run its generated copy from the owned
  root using the already installed compatible Python environment. No dependency
  installation or cloud settings change is part of these scripts.
- `prepare_ios.py` copies the exact retained W13 source, adds the bounded native
  catalog bridge and endpoint-specific TLS transport, and preserves native auth
  source hashes. Current preparation requires an explicit `--build` of at least
  3 and includes the observational driver described below. `prepare_web.mjs`
  then patches only the recognized retained entry.
  Neither operation is an in-place source or installed-app update.
- `check_receiver.py <owned-root>` uses offline signing keys and the real frozen
  verifier/catalog against that new database. It cannot establish real Clerk
  JWT acceptance and does not write device-stage evidence.
- Compile `W13PrivateTransport.swift` with `check-tls.swift` to a new output in
  the owned root, then run it with that root as its argument. This checks actual
  native TLS and rejects a wrong pin/phone loopback configuration. Its successful
  health request must be excluded from phone acceptance evidence.
- The retained/corrected web checks support the exact exported app asset:

```text
node --experimental-vm-modules scripts/w13-workspace-recovery/recovery.test.mjs <original-entry.js> <installed-jsdom/lib/api.js> <exported-private-entry.js>
```

Keep build, archive and export output in the owned root. Use the retained W13
development signing configuration without provisioning updates. Verify the
exported app signature and record its IPA/entry hashes before updating W13.
Preserve bundle identity, app data and the iOS 17 floor. No uninstall, Keychain
reset, auth-policy change, trust bypass or system certificate installation is
needed for this packet.

The native bridge checks `/connection` before requesting a fresh SDK token, then
calls `/workspaces`. It validates the bounded catalog and identity revision
before exposing encounter data. This retains the JWT natively for this operation.
All other provider workflow operations still need their existing authorized
Core integration; this catalog method must not become a generic URL/HTTP bridge.

`W13ObservedAuthDriver.swift` forwards the original driver unchanged and observes
one existing fresh-token call. Only an allowlisted failure category survives;
token/claim values and SDK errors never enter diagnostic output. Original
`NativeWorkspaceAuth` and `NativeTokenPolicy` still decide access. Compile
`check-token-observation.swift` with that wrapper and the original native module
to check unchanged result/error behavior and continued rejection offline.
An application-binding category identifies that defect only; it does not prove
the remaining claims passed. This observation must never become an alternate
authorization implementation.
