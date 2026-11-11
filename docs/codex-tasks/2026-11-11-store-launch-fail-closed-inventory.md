# Store launch fail-closed inventory (MAS+XPC)

Tier 1 documentation. Every condition below can produce the Store launch dialog
formerly worded **“The Mac App Store runtime or its private native services are
unavailable.”** (now `STORE_LAUNCH_FAILURE` Try again / Quit). Labels are
**Verified** against current `main` / this PR’s sources.

Silent second-instance quit (`SCRIBE_STORE_BOOTSTRAP` stage 10) does **not**
show that dialog.

## A. Electron entry → dialog catch

| Code / stage | Exact condition | File:lines | Verified |
| --- | --- | --- | --- |
| `SCRIBE_STORE_BOOTSTRAP:1` (default) | `process.mas !== true` OR Electron ≠ `44.9.1` OR Node not `24.*` | `apps/desktop-companion/src/mac-app-store-xpc.ts:8–11` | Verified |
| `:18` | Inherited `MAC_CHROMIUM_TMPDIR`, or singleton temp prepare fails (abs/realpath/uid/0700/inode/socket path) | `mac-app-store-xpc.ts:18–49`; `standalone/main-mas-xpc.mjs` enter(18) | Verified |
| `:11` | Packaged `app` scheme registration fails or is latched failed | `electron-provider-host.ts:68–74`; `main-mas-xpc.mjs` enter(11) | Verified |
| `:2` | `app.getPath("appData")` fails before userData prep | `main-mas-xpc.mjs` enter(2) | Verified |
| `:3` | `prepareMacAppStoreUserData` custody fail (abs/realpath/owner/mode) | `mac-app-store-xpc.ts:68–78` | Verified |
| `:4` | `app.setPath("userData", …)` fails | `main-mas-xpc.mjs` enter(4) | Verified |
| `:5` | `startElectronProvider` fails before factory stage overwrite | `main-mas-xpc.mjs` enter(5); `electron-provider-host.ts:80+` | Verified |
| `:9` | Not packaged / wrong app name / Store without prepared singleton temp | `electron-provider-host.ts:89–95` | Verified |
| `:10` | Single-instance lock false → **silent quit**, no dialog | `electron-provider-host.ts:96–98`; `electron-security.ts:54–61` | Verified |
| `:12–17` | Ready / renderer verify / session / factory.open / window bind | `electron-provider-host.ts:101–187` | Verified |
| `:6` | Dynamic import of `provider-host.mjs` fails | `main-mas-xpc.mjs` enter(6) | Verified |
| `:7` | `openProvider` / helper resolve / spawn / first `getState` fails | `standalone-provider.ts:32–43`; `native-provider-client.ts:73–88` | Verified |
| `:8` | Window/security binding after owner acquired | `main-mas-xpc.mjs` enter(8) | Verified |
| Profile / helpers | Invalid `provider-profile.json` or helper pin/layout | `standalone-provider-profile.ts:9–25`; `standalone-native-helpers.ts:15–30` | Verified |

## B. Bridge `SCRIBE_STORE_BRIDGE:1–14` → stage 7 → dialog

| Code | Exact condition | File:lines | Verified |
| --- | --- | --- | --- |
| 1 | Approved group absent | `StorePipeBridge.c` | Verified |
| 2 | `argc != 2` | same | Verified |
| 3 | Unknown mode/service or parent PID ≤ 1 | same | Verified |
| 4 | Parent broker prepare/watch refused | `StorePipeBridge.c` / `StoreParentBroker.c` | Verified |
| 5 | Open message refused | `StorePipeBridge.c` | Verified |
| 6 | Reserved; not emitted in current bridge | markers only | Verified |
| 7 | `xpc_connection_create` null | `StorePipeBridge.c` | Verified |
| 8 | Peer requirement setter refused | same | Verified |
| 9 | Other XPC error | same | Verified |
| 10 | `XPC_ERROR_CONNECTION_INVALID` | same | Verified |
| 11 | `XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT` | same | Verified |
| 12 | Reply shape invalid | same | Verified |
| 13 | `XPC_ERROR_CONNECTION_INTERRUPTED` (Mac129 path after CONTAINER:7) | same | Verified |
| 14 | `XPC_ERROR_TERMINATION_IMMINENT` | same | Verified |

## C. Container `SCRIBE_STORE_CONTAINER:1–12` → AUTH_ENTRY:5 → bridge → dialog

| Code | Exact condition | File:lines | Verified |
| --- | --- | --- | --- |
| 1 | `approvedApplicationGroup == nil` | `NativeDesktopStoreContainer.swift:49` | Verified |
| 2 | `SecCodeCopySelf` fail | `:51` | Verified |
| 3 | `SecCodeCheckValidity` fail | `:52` | Verified |
| 4 | `SecCodeCopyStaticCode` fail | `:54` | Verified |
| 5 | `SecCodeCopySigningInformation` fail | `:56–57` | Verified |
| 6 | Entitlements/identifier/bundle shape mismatch | `:59–63` | Verified |
| 7 | `validateMembership` exact key-set / identity / role fail | `:64–65`, `:80–116` | Verified |
| 8 | App Group container URL nil | `:67` | Verified |
| 9 | Non-canonical container path | `:68–69` | Verified |
| 10 | `open` directory fail | `:70–71` | Verified |
| 11 | `fstat` fail | `:73–74` | Verified |
| 12 | UID/mode custody fail | `:74–76` | Verified |

## D. Auth entry `SCRIBE_STORE_AUTH_ENTRY` fail codes → dialog

| Code | Exact condition | File:lines | Verified |
| --- | --- | --- | --- |
| 3 | XPCService plist JoinExistingSession/RunLoopType mismatch | `DesktopProviderMain.swift` store entry | Verified |
| 5 | Catch after container/entry (includes CONTAINER:\*) | same | Verified |
| 8 | `DesktopProviderOwner` construction throws | same | Verified |
| 9 | `DesktopProviderStoreRequest` init throws | `:343–361` | Verified |

Progress codes 1,2,4,6,7 alone do not fail launch.

## E. Related in-window (not this dialog)

| User-visible string | Trigger | File:lines | Verified |
| --- | --- | --- | --- |
| Setup required / not ready for sign-in | `CosmasNativeAuth.enabled != true` / profile `enabled:false` | `application.ts`; `DesktopProviderMain.swift:86–89`; default assemblers | Verified |
| Sign-in unavailable / could not reach sign-in services | Auth phase `unavailable` (Clerk load timeout, init throw, etc.) | `application.ts`; `NativeWorkspaceAuth.swift:126–155` | Verified |

## F. Default packaging vs Store

| Claim | Evidence | Label |
| --- | --- | --- |
| Default `assemble-disabled-desktop-candidate.py` and normal `assemble-standalone-provider.py` stamp `enabled: false` / `CosmasNativeAuth.enabled: false` | `assemble-disabled-desktop-candidate.py:86–91,140–141`; `assemble-standalone-provider.py:150–175` | Verified |
| No prior release script guaranteed enabled auth for Store bridge placement | Search of assemble/prepare scripts; production enable requires founder unlock + `--enable-production-clients` | Verified |
| This PR’s `place_store_bridge` now refuses disabled auth packages | `packaging_guard.require_store_application_auth_enabled`; `prepare-desktop-mas-xpc-variant.place_store_bridge` | Verified |
