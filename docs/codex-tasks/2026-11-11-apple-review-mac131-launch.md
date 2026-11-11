# Codex task for John — Apple Review Mac 1.0 (131) launch failure

Tier 2. Owner: John. Agents cannot perform live Azure, App Store Connect,
notarization, or production unlock steps. Synthetic data only.

## Context

Apple rejected App Store build **1.0 (131)** (reviewed 5 Nov 2026) under
Guideline 2.1(a): error message on launch; did not proceed. Review device was a
clean MacBook Pro 14-inch (Nov 2024), macOS 27.0.1, with internet and **no**
CosmaNeura account or allowlisted network.

Repo source still pins `apps/desktop-companion/desktop-release.json` at build
**126**. Build **131** was stamped outside git via host `release-metadata.json`
during a local assemble/sign/upload. Closest in-repo Store launch failure copy
is the MAS+XPC dialog formerly:

> Scribe could not open  
> The Mac App Store runtime or its private native services are unavailable.

Draft PR `grok/scribe-mac-launch-recoverable` replaces that dead-end with a
**Try again / Quit** dialog and makes in-window `unavailable` / `disabled`
first-launch copy recoverable. It does **not** resign, notarize, or resubmit.

## Exact steps (founder only)

1. **Identify the submitted 131 artifact**  
   On the Mac that built/uploaded 131, locate the signed `.app` / `.pkg` /
   Transporter receipt. Record `CFBundleShortVersionString`, `CFBundleVersion`,
   parent bundle id, and whether the entry was `main-mas-xpc` (Store XPC).

2. **Dump installed entitlements (no secrets)**  
   ```bash
   codesign -d --entitlements :- "/path/to/Cosmaneura Scribe for Mac.app" > /tmp/mac131-parent.entitlements
   codesign -d --entitlements :- "/path/to/.../ScribeDesktopProvider.xpc" > /tmp/mac131-auth.entitlements
   ```
   Compare keys against `NativeDesktopStoreContainer.validateMembership` exact
   set (identity + role + optional `beta-reports-active` Boolean true only).
   Any **extra** Apple-injected key besides that reporting marker fails closed
   (`SCRIBE_STORE_CONTAINER:7` / `SCRIBE_STORE_AUTH_ENTRY:5` class failures).

3. **Clean-install launch with Console filters**  
   Fresh user account or `tccutil reset All com.cosmaneura.scribe.beta.desktop.store`
   (and auth helper id). Launch once. Capture:
   - Visible dialog/window text (exact string)
   - stderr / unified log lines matching `SCRIBE_STORE_BOOTSTRAP:`,
     `SCRIBE_STORE_BRIDGE:`, `SCRIBE_STORE_CONTAINER:`, `SCRIBE_STORE_AUTH_ENTRY:`
   - Whether UI reaches **Sign in** (`Be present. Leave with your note.`)

4. **Confirm packaged auth was enabled**  
   Inspect packaged `provider-profile.json` and auth helper Info.plist
   `CosmasNativeAuth.enabled`. Default assemblers produce `enabled: false`
   (**Setup required**). App Store candidates must use an explicitly enabled
   staging or founder-unlocked production profile. Do not paste publishable
   keys into chat or tickets.

5. **Public network reachability (no allowlist)**  
   From a network that is **not** the office allowlist, verify HTTPS to:
   - Staging Clerk: `https://resolved-emu-53.clerk.accounts.dev`
   - Production Clerk (if 131 was production): `https://clerk.cosmaneura.com`
   - Packaged `coreOrigin` (`staging-app.cosmaneura.com` or `app.cosmaneura.com`)
   If App Service / Front Door / Container Apps **network_acls default Deny**
   with a single allowed IP, Apple’s network cannot reach that host. First
   launch only needs **Clerk** for the sign-in screen; Core/receiver are
   post-auth. Still confirm Core is not required by a launch-time health check
   in the stamped package (none in current source).

6. **Azure checks (read-only)**  
   In the subscription that backs the packaged Core/receiver:
   - App Service / Container App **Access restrictions** / private endpoint
   - Key Vault / app settings presence for the stamped environment (do not
     print secret values)
   - That staging ACA native receiver hostname in
     `ProviderNativeTransport` remains publicly reachable if staging was used  
   Fix is either open required public HTTPS for the packaged hosts or stamp a
   package whose auth frontend is publicly reachable. Do not weaken repo CI.

7. **Rebuild after source fix**  
   After merging the recoverable-launch PR and any entitlement allowlist fix
   proven by step 2:
   - Bump `desktop-release.json` build (e.g. 132) in a reviewed change
   - Assemble/sign Store XPC with **auth enabled**
   - Verify clean-install reaches **Sign in** before any App Store upload
   - Production package/unlock/upload still needs your explicit yes

## Non-goals for agents

No App Store Connect reply, no resubmission, no notarization, no production
unlock, no secret rotation, no merge to `main`, no `codex/*` branch edits.

## Fail-closed inventory

See `docs/codex-tasks/2026-11-11-store-launch-fail-closed-inventory.md` for every Store launch dialog cause with codes and Verified citations.
