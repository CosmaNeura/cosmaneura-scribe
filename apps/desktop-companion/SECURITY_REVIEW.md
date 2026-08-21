# Desktop companion HIPAA and security review

Review date: 2026-08-21

Status: **No-go for PHI or clinical use.** This review covers the mock-only Electron foundation, not
a packaged application or the Recall service as deployed. A BAA is necessary but does not by itself
establish that the implemented technical workflow is HIPAA compliant.

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
| Credential exposure | Capability is main-only, provider-neutral, one-time, and scrubbed after start | `capture-authority.ts`, `controller.ts` |
| Consent bypass | Actor, consent, session, source, and lease are revalidated immediately before start | `capture-authority.ts`, `controller.ts` |
| Concurrent recording | Unique controller lease owner plus required Electron single-instance lock | `recording-lease.ts`, `electron-security.ts` |
| Hidden capture | Indicator is published before adapter start | `controller.ts` |
| Uncertain stop | Grant revoked; warning and lease retained; shutdown confirmation required | `controller.ts` |
| Silent restart | Failed is terminal; no resume API; a stopped session consumes its grant | `controller.ts` |
| PHI in logs | Foundation has no logging surface; tests and errors use fixed metadata | source and secret scan |
| Supply-chain drift | Recall version/config placeholders are exact and dependency is not installed | `config.ts`, `package.json` |

The tests use only synthetic identifiers and contain no audio or transcript content.

## Open blockers before any PHI pilot

- Implement the injected authority against the authenticated backend with tenant binding, durable
  server-side single-use/replay enforcement, certificate validation, and safe retry semantics. The
  foundation currently provides only in-process replay defense and a deny-all default.
- Verify that the active Recall BAA, account, data region, Desktop SDK product, subprocesses, support
  access, telemetry, and deletion behavior cover this exact workflow.
- Pin Electron and Recall package/native artifacts with integrity hashes; complete license,
  vulnerability, provenance, and transitive-dependency review.
- Implement the actual main-process Recall adapter and prove that initialize cannot capture, abort is
  idempotent, and shutdown resolves only after capture is impossible.
- Build the persistent native indicator, prevent close/minimize from hiding it, and add an operating
  system-level emergency termination path.
- Register and serve the custom application protocol securely, apply the CSP response hook, and
  verify every production window uses the reviewed BrowserWindow options and IPC boundary.
- Disable or scrub crash reporting, diagnostics, analytics, dumps, screenshots, and support bundles;
  prove that tokens, meeting metadata, audio, and transcripts cannot enter them.
- Define encrypted local storage and recovery behavior. The current foundation intentionally stores
  no audio, transcript, upload token, or clinical note on disk.
- Complete macOS entitlements/signing/notarization and Windows code/installer signing, signed updates,
  downgrade protection, SBOM/provenance, release separation, and revocation procedures.
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
