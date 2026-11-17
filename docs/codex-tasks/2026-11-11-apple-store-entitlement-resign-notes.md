# Apple App Store vs TestFlight entitlement resign notes

Companion to draft PR `grok/scribe-mac-launch-entitlements`. No secrets.
Staging hold: do not run against staging.

## Rejected build (Verified)

**Verified via App Store Connect (read-only API check, 12 Nov 2026):** version
1.0 REJECTED with build **1.0 (122)** attached, matching Apple's message
(reviewed **10 Nov 2026**, macOS **27.2**).

Repo docs that still say rejected build **131**, review **5 Nov 2026**, or
macOS **27.0.1** are wrong relative to ASC.

**Root cause is unconfirmed.** Related history:

- `docs/flight-plans/2026-11-02-store-distribution-helper-admission.md`
  attributes **Mac122's known startup refusal** to the helper whole-file hash
  after Apple re-signing (**#523**).
- **#528** and **#529** followed that bridge-hash work.
- `beta-reports-active` TestFlight tolerance is already on `main`
  (`docs/flight-plans/2026-11-03-store-testflight-reporting-entitlement.md`).
  That 2026-11-03 plan lists **only** `beta-reports-active` as the extra key
  observed on build **129**.

## What `validateMembership` requires (Verified)

Exact identity keys (must match Team `[REDACTED]` + helper bundle):

- `com.apple.security.app-sandbox` = Boolean `true`
- `com.apple.security.application-groups` = `[approved Store group]`
- `com.apple.developer.team-identifier` = Team ID
- `com.apple.application-identifier` = `TeamID.bundle`

Exact role keys:

- Auth: `keychain-access-groups` = `[TeamID.com.cosmaneura.scribe.beta.desktop.store.auth]`,
  `com.apple.security.network.client` = Boolean `true`
- Audio: `com.apple.security.device.audio-input` + `device.microphone` = Boolean `true`
- Presentation: identity only

Optional Apple TestFlight bookkeeping (already on `main`):

- `beta-reports-active` == Boolean `true` only

Source: `NativeDesktopStoreContainer.validateMembership`.

## `get-task-allow` spelling — unproven for MAS re-sign

| Spelling | Where it appears | Label |
| --- | --- | --- |
| `get-task-allow` | [TN2415](https://developer.apple.com/library/archive/technotes/tn2415/_index.html) profile/signature examples (iOS-oriented listing) | Inferred from TN2415 text |
| `com.apple.security.get-task-allow` | macOS codesign dumps / Hardened Runtime discussions (e.g. public forum and Stack Overflow Release dumps) | Inferred for macOS spelling; **not** proven as a key Apple's Mac App Store re-sign adds as Boolean `false` on Scribe builds |

This PR does **not** tolerate either spelling. Exact-key membership still fails
closed if either key is present (including Boolean `false` or `NSNumber(0)`).
A founder `codesign -d --entitlements` dump from the rejected **122** App Store
install (and its TestFlight sibling) is required before widening.

Do **not** treat “CTO note” as a source. Every TN2415 statement above is
labelled **Inferred** unless linked.

## Source change in this PR

- Keep optional `beta-reports-active` == Boolean `true` (already on `main`).
- Do **not** add `get-task-allow` or `com.apple.security.get-task-allow`
  tolerance (unproven MAS re-sign injection).
- Tests assert both debugger-allow spellings remain rejected for every helper,
  including `false`, `NSNumber(0)`, and `get-task-allow=false` plus an unknown
  filesystem exception key.
- Revert the unrelated `check-native-recording-binding.swift` timing threshold
  change (restore `>= 250` from `main`).

## Exact-key comparison elsewhere (report only; unchanged)

| Component | Compares exact entitlement key **set**? | Citation |
| --- | --- | --- |
| `NativeDesktopStoreContainer.validateMembership` | Yes — `Set(claims.keys) == identity ∪ role ∪ optional reporting` | `NativeDesktopStoreContainer.swift` |
| `StoreParentBroker.c` | No full key-set equality. Requirement string requires specific entitlement facts (`team-identifier`, `application-identifier`, sandbox exists, application-groups equals group) plus identifier/certificate anchors | `StoreParentBroker.c:111` |
| `StorePeerRequirement.c` | No full key-set equality. Lightweight peer policy requires Boolean-true `com.apple.security.app-sandbox` (and inherit for bridge) plus team/signing-identifier / validation-category | `StorePeerRequirement.c:42–44` |
| Store packaging / verification scripts (`prepare-desktop-mas-xpc-variant.py` `xpc_claims`, profile authorization) | Exact claimed maps for signed inputs / profile authorization; not a runtime codesign dictionary key-set compare of the installed parent | `prepare-desktop-mas-xpc-variant.py:67–120` |

## Founder dump commands (verified packaging paths)

Replace `/path/to/Cosmaneura Scribe Store.app` with the installed Store app.
Paths below are taken from packaging scripts:

```bash
APP="/path/to/Cosmaneura Scribe Store.app"

# Parent app (the Store .app itself)
codesign -d --entitlements :- "$APP" > /tmp/mac122-parent.entitlements

# Store bridge — prepare-desktop-mas-xpc-variant.py:24 (BRIDGE_BUNDLE_PATH)
codesign -d --entitlements :- "$APP/Contents/MacOS/ScribeStorePipeBridge" \
  > /tmp/mac122-bridge.entitlements

# Auth / audio / presentation XPC services — embedded under Contents/XPCServices
# (docs/flight-plans/2026-10-19-mas-xpc-helper-boundary.md:76; executables from
# prepare-desktop-mas-xpc-variant.py:113–117 service_info)
codesign -d --entitlements :- \
  "$APP/Contents/XPCServices/ScribeDesktopProvider.xpc" \
  > /tmp/mac122-auth.entitlements
codesign -d --entitlements :- \
  "$APP/Contents/XPCServices/ScribeDesktopAudioStoreService.xpc" \
  > /tmp/mac122-audio.entitlements
codesign -d --entitlements :- \
  "$APP/Contents/XPCServices/ScribePresentationStoreService.xpc" \
  > /tmp/mac122-presentation.entitlements
```

If a local assemble still ships auth as
`Contents/Resources/app/native/ScribeDesktopProvider.app` (direct helper layout;
`scripts/standalone-provider/test_provider_assembly.py:81`), dump that bundle
instead of the `.xpc` path. Record which layout the rejected **122** package
actually used.

## Hosted CI / Mac merge condition

Hosted CI does **not** compile or run `ScribeDesktopAudio`. This agent cannot
run `swift test --filter NativeDesktopStoreContainerTests` (plain or with
`-Xswiftc -DSCRIBE_MAC_APP_STORE_XPC`). Beta will run those two Mac commands
after this push as a required merge condition.
