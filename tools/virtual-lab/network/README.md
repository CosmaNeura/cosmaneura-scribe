# Native lab CONNECT relay

`lab.sh native-relay CONFIG OUTPUT` starts one loopback listener on a physically
verified owned Mac. This is the relay for the separately compiled
`SCRIBE_VIRTUAL_LAB_NETWORK` client. It does not install a client, start a
recording, configure Toxiproxy, or qualify native network-fault behavior.

The private JSON config has exactly six fields: `version: 1`, a canonical UUID
`runId`, UTC `issuedAtUnixSeconds` and `expiresAtUnixSeconds` (at most one hour),
`hardwareUUIDSHA256`, and an unprivileged `listenPort`. The hardware hash must
match both `SCRIBE_LAB_ROOT/target.json` and the actual Mac. The marker must have
purpose `scribe-synthetic-virtual-lab`, its real hostname, and role
`owned-macos-lab` or `owned-macos-guest`. A marker label alone is insufficient.
The config must be owned by the current user, mode0600, beneath the canonical
lab root. The new output directory must have a private existing parent there.

Before running, bind the config hash, relay source/runtime, run identity and
target to the reviewed scenario. Bind the instrumented client's whole signed
bundle and its `ScribeVirtualLabNetwork.json` resource separately. That resource's
`proxyPort` is the Toxiproxy listener; Toxiproxy's upstream is this relay's
`127.0.0.1:listenPort`. Both listeners must have distinct verified ports and the
same bounded run/expiry. A config file does not establish recording consent.

The relay accepts only HTTP/1.1 CONNECT to
`cosmaneura-staging-scribe-native.politesmoke-7989878f.northcentralus.azurecontainerapps.io:443`.
It requires an identical Host header and rejects duplicate/ambiguous fields,
HTTP bodies, proxy credentials and other destinations. It does not terminate
TLS, inspect requests, change certificates/trust, or route other app traffic.
The client keeps its original HTTPS URL and TLS validation. The core's injected
dialer is a loopback test seam; the production entry point always dials the fixed
staging host/port and exposes no destination override.

Bounds: 16 concurrent connections, 4096 accepted connections, 16KiB/5s CONNECT
header, 10s upstream connection, 300s idle, 1GiB per connection and 4GiB per run.
Sockets use stream backpressure. Expiry uses UTC plus a captured monotonic
deadline; rolling the wall clock back cannot extend it. Expiry/normal stop
closes the listener first and allows active exchanges at most210s to finish.
It then destroys only those owned sockets and waits for actual close events.
These are lab resource limits, not product performance budgets.

The exclusive port guard and fsynced receipts record the actual PID, process
start, executable/hash, source hashes, listener and config identity. No dead
guard is reclaimed automatically. Normal closure releases only its verified
guard after both listener and sockets close. Failure retains the guard and
evidence for ownership review; never kill a process by a saved PID alone.

For cleanup, remove only this run's faults so normal Finish/upload can complete,
observe source/recorder stop and preserve saved/encrypted data, then signal the
verified relay process. Its `closed.json` proves relay closure only. It is never
a recorder-stop, upload, captured-audio, or note receipt. Expired/failed relay
connections require normal product recovery; do not replay Finish automatically.

Validation:

```sh
node --test tools/virtual-lab/network/connect-relay.test.mjs
```

Tests create temporary local TCP/TLS listeners and a disposable certificate
trusted only by that test client. They verify opaque TLS and normal hostname
rejection, parser/resource/expiry/cleanup bounds and no upstream fallback. They
contact no staging service and exercise no app/audio. Actual Apple URLSession
routing, Toxiproxy latency/reset, saved audio and recovery remain separate live
gates. TCP stream reset must not be described as IP packet loss.
