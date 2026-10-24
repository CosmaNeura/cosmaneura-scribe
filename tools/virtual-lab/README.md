# Scribe virtual lab

Use Node24, Docker/Compose and Xcode. Tooling and browser contexts are isolated from
installed Scribe. Keep the runtime lock in the output directory for repeat runs.
Product dependencies and deployed Core are not modified.

```sh
export SCRIBE_LAB_ROOT=/absolute/owned/scribe-lab
bash tools/virtual-lab/lab.sh setup
bash tools/virtual-lab/lab.sh up
bash tools/virtual-lab/lab.sh network
bash tools/virtual-lab/lab.sh api-browser
bash tools/virtual-lab/lab.sh browser
bash tools/virtual-lab/lab.sh auth-public
bash tools/virtual-lab/lab.sh auth-bootstrap
bash tools/virtual-lab/lab.sh browser-auth
bash tools/virtual-lab/lab.sh evaluation
```

`auth-bootstrap` uses the retained Clerk SDK and in-memory storage for two dedicated
staging accounts; see native-auth/README.md. Browser tests use official Clerk helpers.
Neither grants Core membership nor proves the native hosted sign-in UI.

`api-browser` uses real Scribe API/PostgreSQL persistence, with explicitly synthetic
authentication, upload storage and transcription. `browser` uses fixture services.
`network` calibrates real TCP delay/drop/recovery and k6 against an owned endpoint;
those timings are not native Record-start timings. Services bind to loopback only.
Each API/browser run creates a fresh database. Run browser suites sequentially.
Override SCRIBE_LAB_SUBNET if the default private subnet conflicts locally.

See evaluation/README.md for speech/Plan checks and the live Core broker adapter,
and native/README.md for Mac2/XCUITest and AVAudioEngine/BlackHole. Native recording
requires an owned app, consent and verified virtual routing. BlackHole needs an
administrator/restart; Mac UI tests need a dedicated unlocked guest/host.

Stop owned services with `bash tools/virtual-lab/lab.sh down`. PostgreSQL data is
ephemeral. Preserve reports and the dependency lock before removing a lab directory.
No paid cloud-device service or production deployment is part of this setup.
