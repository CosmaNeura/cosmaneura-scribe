# Mac App Store — App Review Information

**Status:** Draft for founder fill-in. No App Store Connect action, no
resubmission, and no reply to Apple is authorized by this document.

**Rejected build context — Verified via App Store Connect:** version **1.0**
**REJECTED** with build **1.0 (122)** attached (read-only API check, 12 Nov
2026), matching Apple’s message (**reviewed 10 Nov 2026**, **macOS 27.2**).
Refused under:

| Guideline | What Apple cited | Owner of the fix |
| --- | --- | --- |
| **2.1(a)** Performance — App Completeness | Error at launch | Separate launch-bug track (not this doc). **Root cause still unconfirmed.** |
| **5.2.5** Legal — Intellectual Property | App name uses “Mac” inappropriately | Metadata rename in § Metadata (**Cosmas Scribe**) |

**Related launch-track note:** PR #552 r2 (`c474837`) already records the same
verified build facts (**1.0 (122)** / **10 Nov 2026** / **macOS 27.2**); only
its filename still says `mac131`. Repo
`apps/desktop-companion/desktop-release.json` still pins build **126** (assemble
stamp ≠ rejected Connect build).

This document covers **App Review Information** and **metadata rename notes** a
reviewer / founder needs once a fixed binary can open. It does not authorize
Connect edits, a reply to Apple, or resubmission.

**Hard boundaries:** Synthetic data only. No PHI. No real passwords, Clerk
secrets, API keys, or production credentials in this file, in PRs, or in chat.
Placeholders use angle brackets. Do not paste live values into the repository.
**A staging hold is in effect** — do not start steps that touch staging until
John lifts it (see §3 / §5).

**Product under review:** Electron desktop companion (`apps/desktop-companion`)
with native Clerk auth and audio helpers. Packaging may still expose the old
*Cosmaneura Scribe for Mac* string until the rename PR (#558) lands; listing
name for Connect is **Cosmas Scribe**. Sign-in is Clerk hosted auth, not a
custom username/password form inside the app.

---

## Metadata rename — Guideline 5.2.5 + Apple trademark practice

Apple’s rejection under **5.2.5** said the **app name uses “Mac”
inappropriately**. Limit the 5.2.5 claim to that rejection wording.

The broader rule against using Apple product names (including Mac) in third-party
product naming is attributed to
[Apple’s trademark guidelines for third parties](https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html),
not quoted here as additional 5.2.5 guideline text.

**Public app name — John’s pick (12 Nov 2026):**

| Field | Value |
| --- | --- |
| **New App Store name** | **Cosmas Scribe** |
| **Listing subtitle** | `Record and review visit notes` (keep; contains no “Mac”) |
| Current rejected name (drop) | `Cosmaneura Scribe for Mac` |

Binary / packaging display-name rename is tracked in PR **#558** (out of scope
here). Connect paste remains founder-owned.

### Metadata fields — Name (5.2.5) vs cautious practice

| Connect / asset field | Basis | Action |
| --- | --- | --- |
| **Name** (app name, ≤30 chars) | Apple rejection / **5.2.5** — name used “Mac” inappropriately | Set to **Cosmas Scribe**. |
| **Subtitle** | **Cautious practice** (not an Apple-stated 5.2.5 field rule in the rejection) | Keep **Record and review visit notes** (already has no “Mac” / “for Mac”). |
| **Keyword** | **Cautious practice** | Remove `mac`, `for mac`, and similar tokens. |
| **Description** | **Cautious practice** | **Remove “Mac” / “for Mac”** (and “Scribe for Mac” / “Mac app” phrasing); use Cosmas Scribe or neutral “desktop” wording. |
| **Screenshot** (and preview) text / chrome | **Cautious practice** | **Check screenshots** — re-export so visible titles match **Cosmas Scribe**; no “Mac” / “for Mac” overlays. |

**Still allowed:** saying the binary runs on macOS inside **App Review
Information → Notes**, technical entitlement docs, or internal repo paths.

**Out of scope here:** Connect upload, reply to Apple, and packaging rename
(#558).

---

## 1. Recommended reviewer access path

### Recommendation: pre-provisioned synthetic staging account (not an in-app demo mode)

**Use a founder-provisioned synthetic Clerk user on staging Cosmas**, already
bound to an active Scribe practice and capability, so the Mac reviewer can Sign
in → open workspace → create a walk-in visit → consent → record without hitting
practice-setup or activation dead ends.

| Choice | Summary | Trade-offs |
| --- | --- | --- |
| **A. Synthetic staging account (recommended)** | Normal app path against `https://staging-app.cosmaneura.com` and staging Clerk (`resolved-emu-53`). Founder provisions email/password (or email code) factors Apple can type into App Review Information, activates practice/Scribe grant ahead of review. | Matches how the shipped app works. Needs live staging Core, Clerk, Azure blob upload, and founder ops. Mac UI does **not** currently wire “Complete practice setup” / “Activate Scribe” (iOS does); the account **must** be fully ready before the reviewer launches. No product code change for the access path itself. |
| **B. In-app demo / offline review mode** | Flag-guarded, default-off path that skips live Clerk/Core and plays a canned synthetic visit. | Does **not** exist today. Would be a Tier 2 auth/session change, easy to mis-ship, and still would not prove the real capture/upload path Apple may exercise. Larger blast radius than provisioning one synthetic account. Only consider if staging cannot be kept reachable for Review. |

**Why A is favored (pending John’s confirmation):** There is no production-path
`APP_REVIEW`, demo, or sandbox product toggle in the Mac binary. Meaningful
recording requires live Clerk, Core capture/admission APIs, and Azure block-blob
upload. Building B delays Review and risks live-user behavior unless carefully
sealed; A reuses the existing staging profile gate (`provider-profile.json` →
`enabled: true`, schema 1 staging origin).

`docs/flight-plans/2026-11-04-scribe-account-setup.md` line 82 records John’s
staging choice for the **iOS 95+** App Review demo candidate. Applying that same
staging choice to **this Mac submission** is an **assumption John must confirm**
— it is not independent proof that Mac Review must use staging.

### John decides — staging-sealed vs production-sealed Review binary

Apple approves the **exact binary** that ships. A **staging-sealed** build that
Review approves would reach public customers still sealed to staging unless
release is held manually and a **production** build is submitted afterwards.

The **existing production Store build** is already sealed to
`https://app.cosmaneura.com` / `https://clerk.cosmaneura.com`. It is **not** a
staging Review candidate.

| Option | What it means | Notes |
| --- | --- | --- |
| **1. Staging-sealed Review build** | Submit a **newly assembled** staging-sealed Store package; keep App Store release **manual hold**; after approval, submit a separate production-sealed build for the public listing | Cannot reuse the existing production Store binary; needs a new staging assemble + a later production submission |
| **2. Production-sealed Review build** | Seal the Review binary to production Core/Clerk with a **synthetic** production account | Needs **John’s yes** per `AGENTS.md` (production package / live auth boundary). §2 Notes **WHAT THE APP DOES** and **NETWORK** must be **rewritten** for that binary (no “staging” wording) |

**Do not choose for John.** Record his pick before Connect submit.

### What must be provisioned (by whom) — no live secrets here

| Item | Who | What to create (placeholders only) |
| --- | --- | --- |
| Staging Clerk user | John (Clerk dashboard for staging issuer) | Email `<REVIEWER_SYNTHETIC_EMAIL>`; password or other factor Apple can complete in the hosted sign-in window. Prefer a **dedicated** synthetic reviewer identity — not a personal founder login. Mark account synthetic / non-PHI. |
| Staging Cosmas practice membership | John (Core / Cosmas admin path) | Active practice membership for that Clerk subject; workforce/provider role sufficient for Scribe catalog + walk-in creation. Practice and patients must be invented names only. |
| Scribe capability / activation | John | Account must **not** return `scribe_account_setup_required` for `practice` or `activation` on the Mac client. Complete practice onboarding and Scribe activation **before** Review (browser/Core tools or iOS setup UI). Activation alone is not recording authority; still need capture grant. |
| Capture / cohort grant | John | Founder-selected synthetic practice cohort with Scribe capture enabled for desktop, `non_phi_test_only` / synthetic classification only. |
| Staging package profile | Packaging owner (John for production-bound assemble) | MAS/TestFlight candidate sealed to staging Core origin, `enabled: true`, matching auth/audio helpers, single Azure blob upload origin. Do not submit a disabled assemble receipt. Schema-1 staging packages pin a fixed staging `workspaceId` — see note below. |
| Azure blob upload | Already part of staging topology | Confirm the package’s single `https://<account>.blob.core.windows.net` origin accepts ciphertext from the staging workload path. No SAS strings in this doc. |
| Network reachability | John / ops | Reviewer Mac must reach staging Clerk, `staging-app.cosmaneura.com`, and the blob origin over HTTPS. |

**Schema-1 staging `workspaceId` pin:**
`apps/desktop-companion/src/standalone-provider-profile.ts` defines
`STAGING_WORKSPACE` at line 3 and, for non-production (schema 1) profiles,
returns that constant at line 25 (staging packages do not take a free-form
workspace id from the profile file). Consumers:

- `apps/desktop-companion/src/standalone-provider.ts:55` — cancellation helper
  scoped with `profile.workspaceId`
- `apps/desktop-companion/src/standalone-provider.ts:73-76` — device custody +
  `DurableDesktopRecordStore.open({ … workspaceId })` for pending-creation
  journals

Core encounter / catalog scopes still come from live API responses (e.g.
`apps/capture/src/provider/encounter-setup.ts`,
`apps/capture/src/provider/core-client.ts`), not from rewriting those responses
to `STAGING_WORKSPACE`. Whether the reviewer’s Clerk membership / practice must
**equal** that UUID for admission is **unverified** here; treat the pin as a
hard local-custody/cancellation namespace for schema-1 packages, and confirm
Core membership separately.

**Explicit non-goals for this access path:** production Clerk/Core (unless John
picks option 2 above), real patient data, sharing founder personal credentials
in App Store Connect, shipping a demo-mode binary to live users.

---

## 2. Draft Notes for the Reviewer

Paste into App Store Connect → App Review Information → **Notes**. Keep under
Apple’s ~4,000 character limit. Replace angle-bracket placeholders before
submit. Do **not** put PHI or real production passwords in Notes.

```text
Thank you for reviewing Cosmas Scribe.

WHAT THE APP DOES
Scribe helps a clinician record an in-person or video visit after patient consent, then prepare a visit note in the CosmaNeura web dashboard. This build uses our staging environment with synthetic (invented) data only. Please do not enter real patient information.

SIGN-IN
Sign-in is required. Click Sign in. A secure Clerk browser window opens (ephemeral system browser). Sign in with the demo account in App Review Information (email + password). When the window finishes, return to Scribe. Choose Check access or Open workspace if prompted. You should land on “Today’s patients.”

If you see practice setup or activation messages, the demo account was not pre-activated — contact us with the contact info below rather than continuing.

PERMISSIONS (asked only when you set up recording, not at cold launch)
• Microphone — records the clinician-selected microphone after consent.
• Screen Recording (only if you choose “On a video call”) — captures audio from the meeting window you select after consent.
In System Settings → Privacy & Security, the app appears as “<SYSTEM_SETTINGS_APP_NAME>”. Allow that entry for Microphone (and Screen Recording if used), then return and choose “Check recording access.”

HOW TO RECORD A SYNTHETIC SAMPLE
1. On Today’s patients, choose “+ Walk-in or new patient.”
2. Enter an invented name only, e.g. “Review Test Patient.” Choose “Continue to recording setup.”
3. Prefer “In the room” (microphone only). Avoid video-call mode unless you also allow Screen Recording.
4. If prompted, choose “Check recording access” / “Set up recording access” and allow Microphone.
5. Read the consent line shown aloud (you may role-play the patient). Check “The patient said yes.”
6. Choose “Start recording.” Speak a few invented sentences (no real clinical details).
7. Choose “Finish visit.” Wait for save/upload. Optional: on Today’s patients, open More → Open the dashboard (may require a second browser sign-in to CosmaNeura notes).

NETWORK
The app needs HTTPS to: staging Clerk (hosted sign-in), https://staging-app.cosmaneura.com (catalog, consent, session, upload authority), and one Azure Blob Storage origin for encrypted audio upload. Offline use is not supported for this demo.

DEMO ACCOUNT
Use only the Sign-in Required credentials in App Review Information. All names and speech must remain synthetic. Do not put real passwords in git; credentials live only in App Store Connect / founder secret store.
```

**Maintainer notes (not for Connect paste):**

- Ephemeral system browser:
  `apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/ClerkKitWorkspaceDriver.swift:52-53`
  (`prefersEphemeralWebBrowserSession: true`).
- Sign-in / workspace controls:
  `apps/capture/src/provider/application.ts:129` (“Sign in”),
  `:134-138` (“Check access” / “Open workspace”). Account menu at `:95` is only
  Sign out, Cancel Scribe access, Get help — not dashboard.
- Dashboard control on Today’s patients:
  `apps/capture/src/provider/workspace.ts:348` (`More` → `Open the dashboard`);
  opening it may require a second browser sign-in.
- `<SYSTEM_SETTINGS_APP_NAME>`: fill from the **actual Review candidate** binary
  as shown in System Settings. Use **Cosmas Scribe** once #558 is in that build.
  `preparation-controls.ts:14` only compares `document.title` for in-app repair
  copy — it does **not** prove the System Settings TCC label.
- Mac has **no in-app account deletion**. **Cancel Scribe access** cancels Scribe
  capture access only and must **not** be described to Apple as account deletion
  (Account menu: `application.ts:95`).
- Usage-description strings (packaging drafts, not a checked-in app
  `Info.plist` on this branch):
  `scripts/prepare-desktop-mas-variant.py:74-75` and
  `scripts/prepare-desktop-mas-xpc-variant.py:129-134`
  (`NSMicrophoneUsageDescription` /
  `NSScreenCaptureUsageDescription`).

**Character count (template above, including labels):** keep the filled Notes
(with short email/password reminders if needed) under ~4,000 characters. Prefer
credentials only in the Sign-in Required fields, not duplicated at length in
Notes.

---

## 3. App Review Information field checklist

**A staging hold is in effect. Do not start any step that touches staging until
John lifts it.**

Fill in App Store Connect for the **Mac** app version under review. Values below
are instructions or placeholders — never commit real secrets.

### John decides — which binary Apple will approve (repeat of §1)

Apple approves the exact binary that ships. The existing production Store build
is sealed to `app.cosmaneura.com` / `clerk.cosmaneura.com`. Options (do not pick
here):

1. **Newly assembled staging-sealed** Store package + **manual release hold**,
   then a later production submission; or
2. **Production-sealed** Review build with a synthetic account (**John’s yes**
   per `AGENTS.md`) — rewrite §2 Notes WHAT/NETWORK (no “staging”).

| Field | What to fill |
| --- | --- |
| **Name / Subtitle / Keyword / Description / Screenshots** | See § Metadata — name **Cosmas Scribe**; subtitle **Record and review visit notes**; still remove “Mac” from Description and check Screenshots (cautious practice). |
| **Sign-in required** | **Yes** (checked). The Mac app is unusable for Review without Clerk sign-in. |
| **User name** | `<REVIEWER_SYNTHETIC_EMAIL>` — the staging Clerk primary email John provisions (synthetic only). |
| **Password** | `<REVIEWER_SYNTHETIC_PASSWORD>` — store only in App Store Connect / founder secret store; **never commit real passwords to git**. Or document in Notes if the staging instance uses email one-time code only (then explain the OTP path and ensure John can supply a stable factor Apple accepts). Prefer a password factor for Review simplicity. |
| **Contact information — First name** | `<CONTACT_FIRST_NAME>` (founder contact who can answer within Review hours). |
| **Contact information — Last name** | `<CONTACT_LAST_NAME>` |
| **Contact information — Phone number** | `<CONTACT_PHONE_E164>` — reachable during Review. |
| **Contact information — Email address** | `<CONTACT_EMAIL>` — monitored; not necessarily the demo login. |
| **Notes** | Paste the draft in §2 after replacing placeholders; confirm staging vs any later production package in one plain sentence if the binary’s About badge shows `S` (Staging) or `P` (Production). |
| **Attachment** | Optional. Recommended: short screen recording or PDF of the synthetic walk-in → consent → Finish visit path (no PHI, no real credentials on screen). Filename e.g. `scribe-mac-review-walkthrough.pdf`. Attach in App Store Connect only — do not commit binary media with credentials into git. |
| **Export compliance / encryption** | Follow existing App Store Connect answers for this app; this doc does not change them. |
| **Advertising Identifier** | N/A unless the binary uses IDFA (Scribe Mac does not advertise). |

**Pre-submit smoke (founder; only after John lifts the staging hold if the
candidate is staging-sealed):** cold launch → Sign in with the exact App Review
credentials → Today’s patients → walk-in → mic permission → consent → short
synthetic recording → Finish visit → upload completes. If launch fails, do not
submit; that is the separate 2.1(a) launch-fix track (**root cause still
unconfirmed**).

---

## 4. Code changes needed to support a demo path (not implemented here)

Default recommendation needs **no Mac product code change** if the synthetic
account is fully provisioned. The following would be required only if choosing
**path B (in-app demo mode)** or fixing Mac onboarding parity. None of these are
implemented in this PR. Any future work must be **flag-guarded, default-off**,
and must not change behavior for current live users.

1. **Sealed review/demo profile flag** — package-time or entitlement-gated
   `reviewDemoEnabled` (default `false`); argv/env/renderer must not enable it
   on production profiles (same pattern as `standalone-provider.ts` sealed
   origins).
2. **Demo auth bypass or ticket** — either a Clerk ticket for the synthetic user
   or a sealed mock session accepted only when the flag is on; never accept on
   production Core origin.
3. **Local/mock capture backend** — mock catalog, consent, session, lease, and
   upload so recording works without Azure when demo is on; keep real path
   unchanged when flag is off.
4. **Synthetic seed visit** — invented patient only; refuse non-synthetic names
   if a guard is added.
5. **Optional: wire Mac `openPracticeSetup` / `activateScribe`** — today
   `apps/capture/src/provider/desktop-application.ts` and
   `apps/desktop-companion/src/standalone-provider.ts` expose dashboard +
   cancellation but not the iOS practice/activation host methods
   (`native-application.ts`). Wiring those would let a reviewer finish setup
   in-app; still requires live Core `/onboarding` and activation APIs.
6. **About / Review badge** — visible “Staging / Review demo” so reviewers know
   which environment they are on (About already has Staging `S` / Production
   `P` via `public-app-release.ts`).
7. **Tests** — prove flag off ⇒ identical production/staging behavior; flag on
   ⇒ no network to production hosts.

**Tiny default-off change:** none is required for path A; do not land demo-mode
hooks in this documentation-only change.

### Existing flags (not App Review demo)

| Mechanism | Role | Citation |
| --- | --- | --- |
| `BETA_CONSENT_PREPARATION` | Expired **2026-11-01**; not a Review bypass | `apps/capture/src/provider/beta-consent-preparation.ts:5-10` (`expires: "2026-11-01"`); expiry behavior covered in `beta-consent-preparation.test.ts:10-11` |
| `COSMAS_RECALL_DESKTOP_COMPANION_ENABLED` | Default **false**; Recall pilot | Flag name `apps/desktop-companion/src/config.ts:1-2`; default `DEFAULT_COMPANION_FEATURE_CONFIG.enabled: false` at `:23-25` |
| `provider-profile.enabled` | Real connect gate; false fails closed | `apps/desktop-companion/src/standalone-provider.ts:57-58` (`profile.enabled !== true`) |
| `tools/virtual-lab/` | Lab/synthetic tooling only — not shipped UI | Directory `tools/virtual-lab/` (e.g. `tools/virtual-lab/README.md`) |
| Mock BFF / readiness benchmarks | Test-only | `apps/desktop-companion/test-tools/` |

---

## 5. Codex task for John — live Azure / Clerk / Core setup

**A staging hold is in effect. Do not start any step that touches staging until
John lifts it.**

Copy the block below into a Codex (or founder) task. Agents without Clerk/Azure
dashboard access cannot execute these steps.

```text
TASK: Provision Mac App Store Review synthetic access (staging only)
OWNER: John
REPO CONTEXT: cosmaneura-scribe docs/app-review/mac-app-review-information.md
HOLD: A staging hold is in effect. Do not start any step that touches staging
until John lifts it.
DO NOT: merge PRs; touch App Store Connect submit/reply; use production Clerk/Core
unless John explicitly picks a production-sealed Review binary; put real
passwords in git; use PHI; edit codex/* branches you do not own.

GOAL
Leave a Cosmas Scribe Mac App Store build that a stranger can: launch → Clerk
Sign in → Today’s patients → walk-in synthetic patient → mic consent → short
recording → Finish visit → encrypted upload, without practice-setup walls.
Listing name must not include “Mac” / “for Mac” (5.2.5 rejection).

STEPS
1) Confirm which binary John chose for Review (staging-sealed + manual hold, or
   production-sealed with synthetic account — John’s yes for production).
   If staging-sealed:
   - coreOrigin https://staging-app.cosmaneura.com
   - Clerk issuer resolved-emu-53 (pk_test_ publishable-key prefix for non-prod;
     see NativeClerkConfiguration.swift)
   - provider-profile enabled true
   - About / public release badge shows Staging (S), not Production (P)
   - MAS/XPC helpers and sandbox entitlements match the submitted package
   - schema-1 packages pin workspaceId STAGING_WORKSPACE
     (standalone-provider-profile.ts)
2) In the chosen Clerk instance, create a dedicated synthetic user:
   - Email: choose a disposable reviewer mailbox you control
   - Enable a password factor Apple can type (preferred) or document OTP
   - Do not reuse personal founder login in App Store Connect
   - Store credentials only in 1Password / App Store Connect — never in git
3) In Cosmas/Core for that environment:
   - Attach that Clerk subject to an active synthetic practice (invented name)
   - Grant provider/workforce role needed for catalog + walk-in creation
   - Complete practice onboarding so Mac will not show “Complete practice setup”
   - Complete Scribe activation so Mac will not show “Finish Scribe activation”
     (Mac lacks those buttons; browser or iOS setup UI is required)
   - Enable Scribe capture capability / cohort for desktop on that practice
   - Ensure cancellation status is not blocking new recordings
   - For schema-1 staging packages: confirm local custody/cancellation namespace
     uses pinned STAGING_WORKSPACE; separately confirm Core membership works
     for that synthetic user (Core workspace equality to the pin is unverified
     in docs alone)
4) Azure / upload:
   - Confirm blob account origin matches the package uploadOrigins entry
   - Confirm managed-identity / workload path can authorize block-blob put for
     a synthetic capture (no SAS strings in chat or git)
5) Network:
   - From a clean Mac, verify HTTPS to Clerk, Core origin, blob
6) Dry run with the exact App Review credentials (only after any staging hold
   is lifted if using staging):
   - Sign in → Check access / Open workspace → + Walk-in → invented name →
     In the room → Check recording access → The patient said yes →
     Start recording → speak synthetic lines → Finish visit → confirm upload/save
7) Fill App Store Connect App Review Information using the checklist in
   docs/app-review/mac-app-review-information.md (§3) and Notes (§2).
8) Do not submit or reply to Apple until the separate launch-fix (2.1(a))
   is verified on the same binary (root cause still unconfirmed).

DONE WHEN
Dry run succeeds on the candidate Mac package with only synthetic data, and
App Review fields are ready for John to paste (credentials still outside git).
```

---

## 6. Source map (for maintainers)

| Topic | Location |
| --- | --- |
| MAS / Electron entries | `apps/desktop-companion/standalone/main-mas.mjs`, `main-mas-xpc.mjs`, `main.mjs` |
| Sealed staging/production profile | `apps/desktop-companion/src/standalone-provider-profile.ts` (`STAGING_WORKSPACE` L3; schema-1 pin L25) |
| Standalone host (no practice setup wire) | `apps/desktop-companion/src/standalone-provider.ts` (`workspaceId` use L55, L73-76) |
| Desktop UI host | `apps/capture/src/provider/desktop-application.ts` |
| Session / Sign in UI | `apps/capture/src/provider/application.ts` (Account menu L95; Sign in L129; Check access / Open workspace L134-138) |
| Today’s patients → More → dashboard | `apps/capture/src/provider/workspace.ts:348` |
| System Settings app label | `apps/capture/src/provider/preparation-controls.ts:14,75,80` |
| iOS practice/activation (parity reference) | `apps/capture/src/provider/native-application.ts` |
| Clerk hosted sign-in (ephemeral browser) | `apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/ClerkKitWorkspaceDriver.swift:52-53` |
| Clerk `pk_test_` / `pk_live_` prefix | `apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/NativeClerkConfiguration.swift:110` |
| Mic / screen permission helper entry | `apps/desktop-companion/native/ScribeDesktopAudio/Sources/ScribeDesktopAudioHelper/Main.swift` |
| MAS usage-description drafts | `scripts/prepare-desktop-mas-variant.py:74-75`; `scripts/prepare-desktop-mas-xpc-variant.py:129-134` |
| Consent / walk-in copy | `apps/capture/src/provider/recording-preparation-view.ts`, `encounter-setup-view.ts`, `workspace.ts` |
| Staging App Review demo decision (iOS 95+) | `docs/flight-plans/2026-11-04-scribe-account-setup.md:82` |
| MAS packaging ADR | `docs/adr/0080-dormant-mac-app-store-distribution.md` |
| Repo-pinned release build (126) | `apps/desktop-companion/desktop-release.json` |

---

## Risk class

**Tier 0 for this documentation-only change** (no runtime, auth, or packaging
behavior change). Executing the Codex task (Clerk/practice/capability) is
**Tier 2** operational work under founder authority and is outside this PR.
Cloud agents cannot run the Mac Swift merge filter
`swift test --filter NativeDesktopStoreContainerTests` (plain or
`-DSCRIBE_MAC_APP_STORE_XPC`); Beta runs that on a Mac after push.
