# Mac App Store — App Review Information

**Status:** Draft for founder fill-in. No App Store Connect action, no
resubmission, and no reply to Apple is authorized by this document.

**Rejected build context:** App Store submission **1.0 (122)**, reviewed
**10 Nov 2026** on **macOS 27.2**, was refused under:

| Guideline | What Apple cited | Owner of the fix |
| --- | --- | --- |
| **2.1(a)** Performance — App Completeness | Error at launch | Separate launch-bug track (not this doc) |
| **5.2.5** Legal — Intellectual Property / Apple Products | App name uses “Mac” inappropriately | Metadata rename in § Metadata below (John picks the public name) |

This document covers **App Review Information** and **metadata rename notes** a
reviewer / founder needs once a fixed binary can open. It does not authorize
Connect edits, a reply to Apple, or resubmission.

**Hard boundaries:** Synthetic data only. No PHI. No real passwords, Clerk
secrets, API keys, or production credentials in this file, in PRs, or in chat.
Placeholders use angle brackets. Do not paste live values into the repository.

**Product under review:** Electron desktop companion (`apps/desktop-companion`)
with native Clerk auth and audio helpers. Packaging today still exposes
*Cosmaneura Scribe for Mac* (`PUBLIC_MAC_NAME`); that string must change before
resubmit per § Metadata. Sign-in is Clerk hosted auth, not a custom
username/password form inside the app.

---

## Metadata rename — Guideline 5.2.5 (John’s name pick required)

Apple rejected the listing because the **app name uses “Mac” inappropriately**.
Guideline **5.2.5 Apple Products** states (paraphrased from
[App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)):
do not create an app that appears confusingly similar to an existing Apple
product, interface, or advertising theme, and do not misuse Apple product brand
names in the app. On the Mac App Store, appending “Mac” / “for Mac” to the
product name is treated as that misuse — the storefront already identifies the
platform.

**Public app name — founder pick (do not invent in git):**

| Field | Value |
| --- | --- |
| **New App Store name** | `<JOHN_PICKED_APP_NAME>` — **John chooses**; leave this placeholder until he picks. |
| Name candidates (not chosen) | `Cosmas Scribe` · `Cosmaneura Scribe` |
| Current rejected name (drop) | `Cosmaneura Scribe for Mac` |

Do **not** commit John’s final pick into this file until he states it. After he
picks, replace `<JOHN_PICKED_APP_NAME>` everywhere this doc still says the old
marketing string, and update App Store Connect + packaging display name in a
follow-on change (out of scope for this docs-only PR).

### Metadata fields that must drop “Mac” / “for Mac”

Strip the platform word from every customer-facing App Store Connect field
below. Prefer `<JOHN_PICKED_APP_NAME>` (or a short accurate phrase that does not
contain `Mac`, `macOS`, `iMac`, `MacBook`, etc.).

| Connect / asset field | Why it must drop “Mac” / “for Mac” | Action |
| --- | --- | --- |
| **Name** (app name, ≤30 chars) | Direct 5.2.5 citation — rejected name included “Mac”. | Set to `<JOHN_PICKED_APP_NAME>`. |
| **Subtitle** | Metadata adjacent to the name; Apple reads subtitle with the name for trademark/similarity. | Rewrite without “Mac” / “for Mac”. |
| **Keyword** (keyword field) | Keywords must not pack Apple product brand terms; “mac” / “for mac” invite the same 5.2.5 hit. | Remove `mac`, `for mac`, and similar tokens. |
| **Description** | Long-form listing copy is reviewed for Apple product-name misuse alongside the title. | Replace “Scribe for Mac” / “Mac app” style phrasing with the picked name or neutral “desktop” wording. |
| **Screenshot** (and preview) text / chrome | On-image captions, device frames labeled “Mac”, or UI chrome that brands the product as “… for Mac” count as metadata. | Re-export shots so visible titles match `<JOHN_PICKED_APP_NAME>`; no “Mac” / “for Mac” overlays. |

**Still allowed / not the 5.2.5 problem:** saying the binary runs on macOS inside
**App Review Information → Notes** (reviewer instructions), technical
entitlement docs, or internal repo paths. The prohibition is **customer-facing
listing and product branding**, not documenting that Review happens on a Mac.

**Out of scope here:** binary display-name / `PUBLIC_MAC_NAME` code change,
Connect upload, and any reply to Apple.

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

**Why A wins for this resubmission:** John already selected staging for the App
Review demo (`docs/flight-plans/2026-11-04-scribe-account-setup.md`). There is
no production-path `APP_REVIEW`, demo, or sandbox product toggle in the Mac
binary. Meaningful recording requires live Clerk, Core capture/admission APIs,
and Azure block-blob upload. Building B delays Review and risks live-user
behavior unless carefully sealed; A reuses the existing staging profile gate
(`provider-profile.json` → `enabled: true`, schema 1 staging origin).

### What must be provisioned (by whom) — no live secrets here

| Item | Who | What to create (placeholders only) |
| --- | --- | --- |
| Staging Clerk user | John (Clerk dashboard for staging issuer) | Email `<REVIEWER_SYNTHETIC_EMAIL>`; password or other factor Apple can complete in the hosted sign-in window. Prefer a **dedicated** synthetic reviewer identity — not a personal founder login. Mark account synthetic / non-PHI. |
| Staging Cosmas practice membership | John (Core / Cosmas admin path) | Active practice membership for that Clerk subject; workforce/provider role sufficient for Scribe catalog + walk-in creation. Practice and patients must be invented names only. |
| Scribe capability / activation | John | Account must **not** return `scribe_account_setup_required` for `practice` or `activation` on the Mac client. Complete practice onboarding and Scribe activation **before** Review (browser/Core tools or iOS setup UI). Activation alone is not recording authority; still need capture grant. |
| Capture / cohort grant | John | Founder-selected synthetic practice cohort with Scribe capture enabled for desktop, `non_phi_test_only` / synthetic classification only. |
| Staging package profile | Packaging owner (John for production-bound assemble) | MAS/TestFlight candidate sealed to staging Core origin, `enabled: true`, matching auth/audio helpers, single Azure blob upload origin. Do not submit a disabled assemble receipt. |
| Azure blob upload | Already part of staging topology | Confirm the package’s single `https://<account>.blob.core.windows.net` origin accepts ciphertext from the staging workload path. No SAS strings in this doc. |
| Network reachability | John / ops | Reviewer Mac must reach staging Clerk, `staging-app.cosmaneura.com`, and the blob origin over HTTPS. |

**Explicit non-goals for this access path:** production Clerk/Core, real patient
data, sharing founder personal credentials in App Store Connect, shipping a
demo-mode binary to live users.

---

## 2. Draft Notes for the Reviewer

Paste into App Store Connect → App Review Information → **Notes**. Keep under
Apple’s ~4,000 character limit. Replace angle-bracket placeholders before
submit. Do **not** put PHI or real production passwords in Notes.

```text
Thank you for reviewing <JOHN_PICKED_APP_NAME>.

WHAT THE APP DOES
Scribe helps a clinician record an in-person or video visit after patient consent, then prepare a visit note in the CosmaNeura web dashboard. This build uses our staging environment with synthetic (invented) data only. Please do not enter real patient information.

SIGN-IN
Sign-in is required. Tap Sign in. A secure Clerk browser window opens (ephemeral system browser). Sign in with the demo account in App Review Information (email + password). When the window finishes, return to Scribe. Choose Open workspace if prompted. You should land on “Today’s patients.”

If you see practice setup or activation messages, the demo account was not pre-activated — contact us with the contact info below rather than continuing.

PERMISSIONS (asked only when you set up recording, not at cold launch)
• Microphone — records the clinician-selected microphone after consent. Usage: “Scribe records the selected microphone only after patient consent.”
• Screen Recording (only if you choose “On a video call”) — captures audio from the meeting window you select after consent. Usage: “Scribe captures audio from the meeting selected by the provider after patient consent.”
Use System Settings → Privacy & Security if macOS needs a toggle, then return and choose “Check recording access.”

HOW TO RECORD A SYNTHETIC SAMPLE
1. On Today’s patients, choose “+ Walk-in or new patient.”
2. Enter an invented name only, e.g. “Review Test Patient.” Choose “Continue to recording setup.”
3. Prefer “In the room” (microphone only). Avoid video-call mode unless you also allow Screen Recording.
4. If prompted, choose “Check recording access” / “Set up recording access” and allow Microphone.
5. Read or skip aloud the consent line shown. Check “The patient said yes.”
6. Choose “Start recording.” Speak a few invented sentences (no real clinical details).
7. Choose “Finish visit.” Wait for save/upload. Optional: Account menu → Open dashboard (opens staging CosmaNeura notes in a browser).

NETWORK
The app needs HTTPS to: staging Clerk (hosted sign-in), https://staging-app.cosmaneura.com (catalog, consent, session, upload authority), and one Azure Blob Storage origin for encrypted audio upload. Offline use is not supported for this demo.

DEMO ACCOUNT
Use only the Sign-in Required credentials in App Review Information. All names and speech must remain synthetic. Do not put real passwords in git; credentials live only in App Store Connect / founder secret store.
```

**Character count (template above, including labels):** keep the filled Notes
(with short email/password reminders if needed) under ~4,000 characters. Prefer
credentials only in the Sign-in Required fields, not duplicated at length in
Notes.

---

## 3. App Review Information field checklist

Fill in App Store Connect for the **Mac** app version under review. Values below
are instructions or placeholders — never commit real secrets.

| Field | What to fill |
| --- | --- |
| **Name / Subtitle / Keyword / Description / Screenshots** | See § Metadata — must match `<JOHN_PICKED_APP_NAME>` with no “Mac” / “for Mac”. |
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

**Pre-submit smoke (founder, staging package only):** cold launch → Sign in with
the exact App Review credentials → Today’s patients → walk-in → mic permission
→ consent → short synthetic recording → Finish visit → upload completes. If
launch fails, do not submit; that is the separate 2.1(a) launch-fix track.

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

| Mechanism | Role |
| --- | --- |
| `BETA_CONSENT_PREPARATION` | Expired (2026-11-01); not a Review bypass. |
| `COSMAS_RECALL_DESKTOP_COMPANION_ENABLED` | Default false; Recall pilot. |
| `provider-profile.enabled` | Real connect gate; false fails closed. |
| `tools/virtual-lab/*` | Lab/synthetic tooling only — not shipped UI. |
| Mock BFF / readiness benchmarks | Test-only under `apps/desktop-companion/test-tools/`. |

---

## 5. Codex task for John — live Azure / Clerk / Core setup

Copy the block below into a Codex (or founder) task. Agents without Clerk/Azure
dashboard access cannot execute these steps.

```text
TASK: Provision Mac App Store Review synthetic access (staging only)
OWNER: John
REPO CONTEXT: cosmaneura-scribe docs/app-review/mac-app-review-information.md
DO NOT: merge PRs; touch App Store Connect submit/reply; use production Clerk/Core;
put real passwords in git; use PHI; edit codex/* branches you do not own.

GOAL
Leave a staging <JOHN_PICKED_APP_NAME> Mac App Store build that a stranger can:
launch → Clerk Sign in → Today’s patients → walk-in synthetic patient → mic
consent → short recording → Finish visit → encrypted upload, without
practice-setup walls. Listing name must not include “Mac” / “for Mac” (5.2.5).

STEPS
1) Confirm the binary under Review is sealed to staging:
   - coreOrigin https://staging-app.cosmaneura.com
   - Clerk issuer resolved-emu-53 (pk_test_ path)
   - provider-profile enabled true
   - About / public release badge shows Staging (S), not Production (P)
   - MAS/XPC helpers and sandbox entitlements match the submitted package
2) In staging Clerk, create a dedicated synthetic user:
   - Email: choose a disposable reviewer mailbox you control
   - Enable a password factor Apple can type (preferred) or document OTP
   - Do not reuse personal founder login in App Store Connect
   - Store credentials only in 1Password / App Store Connect — never in git
3) In staging Cosmas/Core:
   - Attach that Clerk subject to an active synthetic practice (invented name)
   - Grant provider/workforce role needed for catalog + walk-in creation
   - Complete practice onboarding so Mac will not show “Complete practice setup”
   - Complete Scribe activation so Mac will not show “Finish Scribe activation”
     (Mac lacks those buttons; browser or iOS setup UI is required)
   - Enable Scribe capture capability / cohort for desktop on that practice
   - Ensure cancellation status is not blocking new recordings
4) Azure / upload:
   - Confirm staging blob account origin matches the package uploadOrigins entry
   - Confirm managed-identity / workload path can authorize block-blob put for
     a synthetic capture (no SAS strings in chat or git)
5) Network:
   - From a clean Mac, verify HTTPS to Clerk, staging-app.cosmaneura.com, blob
6) Dry run with the exact App Review credentials:
   - Sign in → Open workspace → + Walk-in → invented name → In the room →
     Check recording access → The patient said yes → Start recording →
     speak synthetic lines → Finish visit → confirm upload/save
7) Fill App Store Connect App Review Information using the checklist in
   docs/app-review/mac-app-review-information.md (§3) and Notes (§2).
8) Do not submit or reply to Apple until the separate launch-fix (2.1(a))
   is verified on the same binary.

DONE WHEN
Dry run succeeds on the candidate Mac package with only synthetic data, and
App Review fields are ready for John to paste (credentials still outside git).
```

---

## 6. Source map (for maintainers)

| Topic | Location |
| --- | --- |
| MAS / Electron entries | `apps/desktop-companion/standalone/main-mas*.mjs`, `main.mjs` |
| Sealed staging/production profile | `apps/desktop-companion/src/standalone-provider-profile.ts` |
| Standalone host (no practice setup wire) | `apps/desktop-companion/src/standalone-provider.ts` |
| Desktop UI host | `apps/capture/src/provider/desktop-application.ts` |
| Session / Sign in UI | `apps/capture/src/provider/application.ts` |
| iOS practice/activation (parity reference) | `apps/capture/src/provider/native-application.ts` |
| Clerk hosted sign-in | `apps/capture/native-plugins/cosmas-native-auth/.../ClerkKitWorkspaceDriver.swift` |
| Mic / screen permission prompts | `apps/desktop-companion/native/ScribeDesktopAudio/.../Main.swift` |
| Consent / walk-in copy | `recording-preparation-view.ts`, `encounter-setup-view.ts`, `workspace.ts` |
| Staging App Review demo decision | `docs/flight-plans/2026-11-04-scribe-account-setup.md` |
| MAS packaging ADR | `docs/adr/0080-dormant-mac-app-store-distribution.md` |

---

## Risk class

**Tier 0 for this documentation-only change** (no runtime, auth, or packaging
behavior change). Executing the Codex task (Clerk/practice/capability) is
**Tier 2** operational work under founder authority and is outside this PR.
