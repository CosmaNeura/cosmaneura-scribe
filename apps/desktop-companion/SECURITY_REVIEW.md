# Desktop companion HIPAA and security review

Review date: 2026-08-23

Status: **No-go for PHI or clinical use.** This review covers the hard-disabled Electron bootstrap,
provider-neutral Recall adapter, and source/native provenance gate—not a packaged application or the
Recall service as deployed. A BAA is necessary but does not by itself establish that the implemented
technical workflow is HIPAA compliant.

## Reviewed trust boundaries

1. The Cosmas backend is the authority for tenant identity, actor, appointment/session authorization,
   consent state, source lease, and issuance of a short-lived single-use capture capability.
2. The Electron main process owns the backend channel, Recall SDK adapter, recording lease, and
   capture state machine.
3. The sandboxed renderer receives metadata-only state and fixed start/stop controls through the
   preload bridge. It never receives the upload token or SDK access.
4. The native persistent indicator is the safety signal when the renderer is hidden, unavailable, or
   compromised.
5. Recall receives capture under its BAA and the separately reviewed retention/deletion policy.

## Controls present in this foundation

| Risk | Implemented control | Evidence |
| --- | --- | --- |
| Privileged renderer | Sandbox, context isolation, Node disabled, webview disabled | `electron-security.ts` |
| Renderer exfiltration | Local-only CSP, denied navigation/windows/downloads/permissions | `electron-security.ts` |
| IPC confused deputy | Fixed channels, exact schemas, 16 KiB limit | `protocol.ts`, `electron-ipc.ts` |
| Untrusted frame | Expected webContents, top-frame identity, exact `app://cosmas` origin | `electron-ipc.ts` |
| Credential exposure | PKCE verifier, bearer, and capability are main-only; OS encryption has no plaintext fallback; capability is scrubbed after start | `browser-handoff.ts`, `secure-state-store.ts`, `capture-authority.ts`, `controller.ts` |
| Consent bypass | Actor, consent, session, source, and lease are revalidated immediately before start | `capture-authority.ts`, `controller.ts` |
| Concurrent recording | Unique controller lease owner plus required Electron single-instance lock | `recording-lease.ts`, `electron-security.ts` |
| Hidden capture | Indicator is published before adapter start | `controller.ts` |
| Uncertain stop | Grant revoked; warning and lease retained; shutdown confirmation required | `controller.ts` |
| Native safety signal | Fixed-text tray status is outside the renderer; close/minimize cannot hide active or uncertain capture | `electron-recording-indicator.ts` |
| Emergency termination | Native stop-and-quit uses trusted controller shutdown, then one-shot forced process exit after 20 seconds | `electron-shutdown.ts`, `electron-recording-indicator.ts` |
| Silent restart | Failed is terminal; no resume API; a stopped session consumes its grant | `controller.ts` |
| PHI in logs | Foundation has no logging surface; tests and errors use fixed metadata | source and secret scan |
| Supply-chain drift | Isolated exact locks, independent hashes, exact-source patch, retained archives/tree receipt, clinical release false | `vendor-runtime/package-lock.json`, `vendor/recall-desktop-sdk.provenance.json` |
| Vendor logging | Command/event payloads and native stdout/stderr removed or redacted by an exact-hash patch | `scripts/recall-vendor-patch.mjs` |
| Ambient secrets | Vendor `RECALL_*` forwarding removed; adapter init has only region, restart, and permission keys | `recall-sdk-adapter.ts`, vendor patch |
| Provider activation | Product, packaging, capture, clinical, routable-origin, and provenance locks all fail closed before Recall loads | `desktop-adapter-bootstrap.ts`, `config.ts`, `recall-sdk-loader.ts` |
| Renderer bootstrap | Fixed local assets, custom protocol, CSP, denied permissions/navigation/windows/downloads | `main-entry.ts`, `electron-app.ts`, `electron-security.ts` |
| Browser handoff | Exact custom URLs, fragment-only launch material, S256 PKCE, random state, strict age/state validation | `browser-handoff.ts`, `desktop-session.ts` |
| OS deep-link ingress | Exact protocol parsing, single-instance cold/warm routing, no URL logging, disabled-build no-op | `electron-deep-link.ts`, `main-entry.ts` |
| Platform API | HTTPS origin pin, omitted cookies/referrer, no redirects/cache, bounded exact response schemas, value-free errors | `desktop-api.ts` |
| Package hardening | Checked-in hard-off policy, complete fuse set, unsigned distribution denied, signing/notarization required | `release/package-policy.json`, `harden-electron-package.mjs` |
| Application diagnostics | Electron Crashpad is never started; logging, NetLog, tracing, remote debugging, Node reports/inspection, analytics, and support bundles are absent or rejected before ready | `electron-diagnostics.ts`, `main-entry.ts` |
| Signed-artifact rejection | Exact Team ID/publisher, timestamp, notarization/stapling, Gatekeeper/AuthentiCode, ASAR, and fuse checks fail closed before publication | `verify-signed-desktop-artifacts.mjs`, `verify-windows-publisher.ps1` |

The tests use only synthetic identifiers and contain no audio or transcript content.

## Open blockers before any PHI pilot

- Implement the injected authority against the authenticated backend with tenant binding, durable
  server-side single-use/replay enforcement, certificate validation, and safe retry semantics. The
  foundation currently provides only in-process replay defense and a deny-all default.
- Verify that the active Recall BAA, account, data region, Desktop SDK product, subprocesses, support
  access, telemetry, and deletion behavior cover this exact workflow.
- Resolve Recall's undeclared npm/native license and complete legal, vulnerability, provenance,
  transitive-dependency, and Electron binary review. The manifest and isolated lock are not yet a
  signed release SBOM or attestation.
- Exercise the actual adapter against verified native artifacts on supported macOS and Windows and
  prove that initialize cannot capture, abort is idempotent, and shutdown resolves only after capture
  is impossible. The 2.0.28 Apple Silicon inputs, retained archives, patched wrapper, receipt, and
  extracted tree pass exact-hash verification. The approved no-token macOS run now proves native
  initialization, the accessibility/screen-capture/microphone permission paths, and clean shutdown;
  its bounded detector window saw no synthetic meeting, so meeting detection and every capture
  lifecycle check remain open. The upstream executable/top-level dylibs are ad-hoc signed and
  GStreamer is unsigned, so the complete nested tree must be signed and verified in the final
  application artifact.
- Exercise the native indicator, close/minimize guard, and implemented emergency stop-and-quit path
  in signed macOS and Windows artifacts. Prove the 20-second deadline terminates the real vendor
  process tree and creates a reconciled uncertain outcome when graceful shutdown cannot complete.
- Package and inspect the implemented custom protocol/bootstrap and prove every production window
  uses the reviewed BrowserWindow options and IPC boundary.
- Inventory and test operating-system crash facilities plus the verified native SDK for crash dumps,
  screenshots, temporary files, and support artifacts. The application-controlled Crashpad,
  logging, remote-debugging, analytics, and support-bundle surfaces are disabled; native/OS evidence
  must still prove that tokens, meeting metadata, audio, and transcripts cannot enter artifacts.
- Define encrypted local storage and recovery behavior. The current foundation intentionally stores
  no audio, transcript, upload token, or clinical note on disk.
- The exact Packager 20.3.0 assembly-only graph passes the current lock/license/install-script and
  vulnerability gates. The fixed-input lane and its stage/ASAR/loose-runtime receipt checks are now
  implemented but remain blocked by the false packaging gate and have not produced an artifact.
  Separately review the first unsigned native-runner assembly, then select macOS nested-code
  signing/notarization and Windows installer/signing paths, signed updates, downgrade protection,
  SBOM/provenance, release separation, and revocation.
- Complete webhook authentication, replay/idempotency controls, bounded retention, delete-after-
  ingestion evidence, orphan reconciliation, and bot/desktop mutual exclusion in the backend.
- Run synthetic Zoom and Meet tests on supported macOS and Windows versions, including permissions,
  network loss, device changes, crashes, forced process termination, restart, and update rollback.
- Approve support access, incident response, breach response, audit retention, workforce access,
  privacy notice/consent wording, and clinical safety procedures.

## Ongoing and final review gates

Every change touching dependencies, preload, IPC, navigation, permissions, persistence, logging,
updates, capture lifecycle, backend grants, or Recall payloads requires a fresh threat-model review
and regression tests. Security findings block feature-flag enablement.

Before a PHI pilot, conduct a final end-to-end review against the built and signed artifacts and the
deployed backend/Recall configuration. Capture evidence for each blocker above, run dependency and
secret scans, inspect packaged contents, verify logs and crash artifacts, and execute the failure
matrix on both operating systems. Product code must continue to report **not approved for PHI** until
that review is signed by the designated security, privacy, clinical-safety, and operations owners.
