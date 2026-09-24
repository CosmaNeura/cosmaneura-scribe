# Synthetic desktop pipe checks

After installing the repository dependencies and building the secure-queue
TypeScript package, run on macOS with an installed Node 24 binary:

```sh
python3 scripts/desktop-native/run-pipe-fixtures.py /private/tmp/scribe-pipe-check-unique --node /absolute/path/to/node
```

The output must be a new temporary directory. The runner compiles the current
Swift library with the invented PCM source, runs the driver, recorder and
SQLite crash/recovery fixtures, and retains source hashes, compiler output and
test results. It does not invoke the physical audio source or Keychain.

The assembled copy changes only `nativeDesktopFenceDirectory()` to return a
fixed private directory within that output. The original coordinator, file
identity checks, epoch, locks and native lease remain unchanged. A separate
fixture process holds the coordinator during the tests and supplies its actual
ticket through test-only inputs. The runner closes that process afterward;
retained test files are separate from installed application custody.

Existing opt-ins now exercise `--capture-v2`. Supplying only the historical
`SCRIBE_DESKTOP_PIPE_FIXTURE` binary without its coordinator ticket is insufficient.

## Audio-helper AppKit startup

```sh
python3 scripts/desktop-native/check-appkit-bootstrap.py /private/tmp/scribe-appkit-check-unique
```

This compiles the unchanged product audio-helper entry point against a test-only
library stand-in, then starts fresh processes for its availability and capture
dispatch modes. It verifies AppKit initialization, prohibited activation policy,
main-thread execution and MainActor resumption through the application runloop.
It never queries permissions, requests setup, selects a window or creates audio.
The native screen filter itself still requires installed, owner-operated testing;
this check does not claim that physical recording has passed. The pipe suite also
checks discard after a child exits before readiness without a normal stop receipt.
