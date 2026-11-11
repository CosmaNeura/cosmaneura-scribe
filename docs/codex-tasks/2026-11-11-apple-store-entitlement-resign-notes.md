# Apple App Store vs TestFlight entitlement resign notes

Companion to draft PR `grok/scribe-mac-launch-entitlements`. No secrets.

## What `validateMembership` already requires (Verified)

Exact identity keys (must match Team `JVV65668U6` + helper bundle):

- `com.apple.security.app-sandbox` = Boolean `true`
- `com.apple.security.application-groups` = `[approved Store group]`
- `com.apple.developer.team-identifier` = Team ID
- `com.apple.application-identifier` = `TeamID.bundle`

Exact role keys:

- Auth: `keychain-access-groups` = `[TeamID.com.cosmaneura.scribe.beta.desktop.store.auth]`,
  `com.apple.security.network.client` = Boolean `true`
- Audio: `com.apple.security.device.audio-input` + `device.microphone` = Boolean `true`
- Presentation: identity only

Source: `NativeDesktopStoreContainer.validateMembership`.

## Apple-injected / profile bookkeeping keys

| Key | TestFlight / uploaded | App Store retail resign | Privilege grant? | Label |
| --- | --- | --- | --- | --- |
| `beta-reports-active` | Boolean `true` often **added** by Apple TestFlight processing (Mac129) | Often **absent / removed** on retail App Store builds | No (TestFlight reporting marker) | Verified for TestFlight add (`docs/flight-plans/2026-11-03-store-testflight-reporting-entitlement.md`); **Inferred** for App Store removal (CTO note + TN2415 describing it as App Store distribution / TestFlight marker) |
| `com.apple.developer.team-identifier` | Set from profile / signing | Set / retained to Team ID | Identity, not a new capability | Verified required by our check; TN2415 lists it |
| `com.apple.application-identifier` | Set `TeamID.bundle` | Set / retained | Identity | Verified required; TN2415 (`application-identifier` / macOS `com.apple.application-identifier`) |
| `keychain-access-groups` | Exact auth group for Store auth helper | Must remain exact; Apple may rewrite prefix wildcards to Team ID at sign time | Yes (credential group) — **kept strict** | Verified strict in source; TN2415 documents profile → signature qualification |
| `get-task-allow` | `true` on development profiles; typically absent or `false` on distribution | May appear as Boolean `false` after distribution resign | Debugger attach only when `true`; `false` grants nothing | **Inferred** (TN2415 definition; no Mac131 codesign dump in-repo). This PR tolerates **Boolean false only** |

TN2415 also states the profile generation service can inject entitlements the developer does not control. Any key outside identity + role + the two Apple markers above still fails closed (**Verified** rejection path).

## Source change in this PR

Tolerate only:

1. Optional `beta-reports-active` == Boolean `true` (existing TestFlight fix)
2. Optional `get-task-allow` == Boolean `false` (distribution debugger-denied marker)

Do **not** widen sandbox, network, mic, App Group, or Keychain checks. Do **not** accept `get-task-allow` true or coerced types.

## Founder confirmation still required

Dump entitlements from rejected Mac 131 (App Store install) and the uploaded/TestFlight sibling:

```bash
codesign -d --entitlements :- "/path/to.app" > /tmp/mac131-parent.entitlements
codesign -d --entitlements :- "/path/to/ScribeDesktopProvider.xpc" > /tmp/mac131-auth.entitlements
```

If Apple injected any **additional** non-grant key beyond the two markers, open a follow-up with that exact key list before broadening further.
