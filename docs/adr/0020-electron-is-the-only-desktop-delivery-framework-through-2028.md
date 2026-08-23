# ADR 0020: Electron is the only desktop delivery framework through 2028

**Status:** Accepted

## Context

The first desktop capture adapter uses Recall's supported npm SDK. Electron hosts that SDK directly.
Delivering the same adapter in Tauri would add a bundled Node.js sidecar, process supervision, a
private inter-process protocol, and another packaging, signing, testing, and support matrix.

CosmaNeura intends to own its capture stack over time, but maintaining two desktop shells during the
initial delivery period would divide the team without changing the vendor-neutral clinical and API
boundaries.

## Decision

Electron is the sole macOS and Windows desktop delivery framework for the 24-month period ending
2028-08-23. The Electron main process owns browser PKCE, OS-protected credential storage, the
generated desktop API client, provider-adapter lifecycle, and local stop fail-safe. The sandboxed
renderer is presentation-only and receives no credentials, patient identifiers, or raw provider
capabilities.

Recall remains behind `DesktopCaptureAdapter`. Tauri remains the long-term shell roadmap for a
wholly owned vertical stack after CosmaNeura owns a production-ready native capture engine. No
parallel Tauri implementation, packaging, signing, testing, or release work is planned during this
Electron horizon.

## Consequences

- Desktop estimates, release automation, acceptance matrices, security updates, and support assume
  Electron only.
- Replacing Recall changes the adapter rather than Scribe's consent, custody, lifecycle, or
  transcript contracts.
- A future Tauri implementation reuses those contracts and requires a separately reviewed and
  staffed migration tranche.
- Electron's Chromium and Node runtimes create an ongoing rapid security-update obligation.

## Related

- Central architecture ADR 0018
- Central architecture ADR 0019
- Local ADR 0009
