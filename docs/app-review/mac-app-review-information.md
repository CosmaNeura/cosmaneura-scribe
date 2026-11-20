# Mac App Store — App Review Information

**Status:** Ready for founder paste into App Store Connect after a signed
production-sealed build 132 is assembled and the two pre-upload checks below
pass. This document does not authorize Connect submit, reply to Apple, or
production unlock by itself.

**Live users:** The Mac App Store listing has never been approved, so there are
**no existing Store users**. Changing the Review candidate to a production-sealed
build 132 does not migrate, break, or notify any live Store install base.

**Rejected build context — Verified via App Store Connect:** version **1.0**
**REJECTED** with build **1.0 (122)** attached (read-only API check, 12 Nov
2026), matching Apple’s message (**reviewed 10 Nov 2026**, **macOS 27.2**).
Refused under:

| Guideline | What Apple cited | Owner of the fix |
| --- | --- | --- |
| **2.1(a)** Performance — App Completeness | Error at launch | Separate launch-bug track (not this doc). **Root cause still unconfirmed.** |
| **5.2.5** Legal — Intellectual Property | App name uses “Mac” inappropriately | Metadata rename in § Metadata (**Cosmas Scribe**) |

**John’s decisions (17 Nov 2026, ~7:38am ET):**

| Decision | Value |
| --- | --- |
| Store Review / ship binary environment | **Production** (`https://app.cosmaneura.com` / `https://clerk.cosmaneura.com`) |
| Version / build to assemble | **1.0** / build **132** (App Store Connect highest was 131; repo stamp was 126) |
| Public listing name | **Cosmas Scribe** (already set; packaging rename in #558) |

Repo stamp: `apps/desktop-companion/desktop-release.json` is now marketing
**1.0.0** / build **132**. Environment sealing still uses the existing founder
path `scripts/assemble-production-provider.py` with
`--i-am-john-unlocking-production`, `--production-inputs`, and
`--enable-production-clients` (see § Production sealing — missing inputs).

**Hard boundaries:** Synthetic data only. No PHI. No real passwords, Clerk
secrets, API keys, or production credentials in this file, in PRs, or in chat.
Placeholders use angle brackets. Do not paste live values into the repository.

**Product under review:** Electron desktop companion (`apps/desktop-companion`)
with native Clerk auth and audio helpers. Listing name for Connect is
**Cosmas Scribe**. Sign-in is Clerk hosted auth, not a custom username/password
form inside the app.

**Account deletion (Guideline 5.1.1(v)) — DONE:** In-app **Delete account** is
available on Mac for signed-in users (**Account → Delete account**). That path
calls the Core self-delete endpoint (`DELETE /v1/me/account`). After the server
confirms deletion (`200` `deleted` / `already_deleted`), this device wipes local
clinical data and signs out. Offline or unconfirmed failures, and `401`, keep
local clinical data and do not delete the account (`401` uses keep-session
failure copy and clears credentials for re-auth; no clinical wipe). This ships
in build **132** (same control as iPhone; Scribe #519 + #563). **Cancel Scribe
access** only cancels capture access and must not be described as account
deletion.

**Signed-build checks still owed before any upload:**

1. **#552** — real **Try again** path on a signed Store package (recoverable
   launch dialog), not only unit/fixture coverage.
2. **#558** — install-over-the-old-app check: install over the previous Store
   build with an existing synthetic journal; confirm open + Keychain
   “Safe Storage” item name unchanged
   (`docs/mac-app-store-public-display-name.md`).

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

---

## Review answers for the 12 Nov rejection follow-ups

Fill these into App Store Connect App Review Information (and Notes where
noted). Do not invent SOC 2, HIPAA *certification*, EHR write-back, checkout,
or branded meeting-product claims.

| Topic | Paste / answer |
| --- | --- |
| **Regions** | United States |
| **Regulated field** | Cosmas Scribe is for **licensed clinicians**. Practices that use it sign a **Business Associate Agreement (BAA)** with CosmaNeura before handling protected health information. App Review uses a **synthetic** account and invented patient names only. |
| **App Store distribution (Guideline 3.2)** | Cosmas Scribe is distributed on the **Mac App Store for any licensed clinician** who creates a CosmaNeura practice account. It is **not** a private / custom enterprise build limited to one organization. |
| **AI services (exact repo names)** | After consent and upload, server-side processing uses **Azure AI Speech** (speech-to-text / diarization; ADR 0008 / `docs/PLAN.md`) and, when Spanish→English translation is admitted, **Azure GPT-4.1** (ADR 0039). The Mac app itself ends at a clean diarized transcript path into the CosmaNeura web dashboard; it does not claim note styling inside the Store binary. |
| **System Settings app name** | **Cosmas Scribe** (Store public display name from #558 / `PUBLIC_STORE_MAC_NAME`). |
| **Meeting / screen-recording path** | Product UI includes **On a video call** (meeting-window audio) with unit coverage under `apps/capture/src/provider/*meeting*` / desktop-audio preflight tests and `NSScreenCaptureUsageDescription` in MAS packaging drafts. Prefer **In the room** (microphone only) for the Review walkthrough. Do **not** name third-party meeting products in Notes. |

**Do not claim:** SOC 2, HIPAA certification, EHR write-back, in-app checkout, or
branded meeting-product integrations.

---

## 1. Recommended reviewer access path

### Recommendation: pre-provisioned synthetic **production** account (not an in-app demo mode)

**Use a founder-provisioned synthetic Clerk user on production Cosmas**, already
bound to an active Scribe practice and capability, so the Mac reviewer can Sign
in → open workspace → create a walk-in visit → consent → record without hitting
practice-setup or activation dead ends. Synthetic / non-PHI only.

| Choice | Summary | Trade-offs |
| --- | --- | --- |
| **A. Synthetic production account (John’s pick for this Store binary)** | Normal app path against `https://app.cosmaneura.com` and production Clerk (`https://clerk.cosmaneura.com`). Founder provisions email/password (or email code) factors Apple can type into App Review Information, activates practice/Scribe grant ahead of review. | Matches the binary Apple will approve. Needs John’s production yes (already given for this Store packaging target), live production Core/Clerk reachability for Review, and a dedicated synthetic identity — never a personal founder login. |
| **B. In-app demo / offline review mode** | Flag-guarded, default-off path that skips live Clerk/Core and plays a canned synthetic visit. | Does **not** exist today. Would be a Tier 2 auth/session change. Not selected. |

**Why A matches this submission:** John directed the Mac App Store build at
**production**. Apple approves the exact binary that ships. A staging-sealed
binary would still need a later production resubmit before public customers.

### What must be provisioned (by whom) — no live secrets here

| Item | Who | What to create (placeholders only) |
| --- | --- | --- |
| Production Clerk user (main demo) | John (Clerk dashboard for production issuer) | Email `<REVIEWER_SYNTHETIC_EMAIL>`; password or other factor Apple can complete in the hosted Sign-in Required fields. Prefer a **dedicated** synthetic reviewer identity — not a personal founder login. Mark account synthetic / non-PHI. This is the primary Review walkthrough account — **keep it**; **do not** use it for Delete account. |
| Production Clerk user (Apple Delete throwaway) | John or the Beta Tester (with John’s approval) | Fresh synthetic throwaway email `<REVIEWER_DELETION_TEST_EMAIL>` created **before each Review** for Apple’s Delete account test only. Password goes **only** into App Store Connect sign-in fields and a private password store — **never** into Notes, this doc, chat, or logs. Same synthetic / non-PHI rules; practice/activation/capture grant required like the main demo. **Apple** deletes this account during Review; our team **never** deletes it. |
| Team Delete smoke throwaway (not Apple’s) | Beta Tester / founder | Separate synthetic account `<TEAM_DELETION_SMOKE_EMAIL>` used only for the pre-submit Delete smoke on signed build 132. Not the Apple Review throwaway. Password only in a private password store — never Notes, this doc, chat, or logs. |
| Production Cosmas practice membership | John (Core / Cosmas admin path) | Active practice membership for the main demo and each throwaway Clerk subject; workforce/provider role sufficient for Scribe catalog + walk-in creation. Practice and patients must be invented names only. |
| Before each Review (runbook) | John or the Beta Tester (with John’s approval) | Create a **fresh** Apple Delete throwaway for Review; keep the main demo account. Do not delete Apple’s throwaway yourselves — Apple deletes it during Review. Re-grant practice/activation/capture as needed. Placeholders only in git. |
| Scribe capability / activation | John | Account must **not** return `scribe_account_setup_required` for `practice` or `activation` on the Mac client. Complete practice onboarding and Scribe activation **before** Review (browser/Core tools or iOS setup UI). Activation alone is not recording authority; still need capture grant. |
| Capture / cohort grant | John | Founder-selected synthetic practice cohort with Scribe capture enabled for desktop, `non_phi_test_only` / synthetic classification only. |
| Production package profile | John (founder unlock) | MAS/TestFlight candidate sealed via existing `assemble-production-provider.py` + `--production-inputs` + `--enable-production-clients`. About badge must show Production (**P**). Do not submit a disabled assemble receipt. |
| Azure blob upload | Part of production topology | Confirm the package’s single `https://<account>.blob.core.windows.net` origin accepts ciphertext from the production workload path. No SAS strings in this doc. |
| Network reachability | John / ops | Reviewer Mac must reach production Clerk, `app.cosmaneura.com`, and the blob origin over HTTPS (not office-IP allowlisted only). |

**Explicit non-goals:** real patient data, sharing founder personal credentials
in App Store Connect, shipping a demo-mode binary, staging-sealed Store binary
for this submission.

### Production sealing — missing inputs (stop; no placeholders)

The repo’s existing production packaging mechanism is:

```sh
SCRIBE_FOUNDER_PRODUCTION_UNLOCK=1 \
  python3 scripts/assemble-production-provider.py \
  --i-am-john-unlocking-production \
  --production-inputs /path/to/production-inputs.json \
  --enable-production-clients \
  # …plus existing host/native/receipt paths from the production flight plans
```

Offline helper `scripts/standalone-provider/write_production_inputs.py` writes the
founder `--production-inputs` JSON (schema 1) from a Core `production_live_settings.tf`
pin plus local helper build directories (assemble auth/audio layout); it never prints
binding values. Live inputs stay outside git.

`scripts/standalone-provider/prepare_production_profiles.py` projects that input
into sealed `provider-profile.json` / Info.plist fragments. **Those live values
are not in git.** Do not invent them. Before a production-sealed Store assemble
can finish, John must supply (outside the repository) at least:

| Missing input | Why it is required |
| --- | --- |
| Production `--production-inputs` JSON (schema 1: `receiver` + `client` + `desktop_helpers`) | Founder assemble refuses without it |
| `client.publishable_key` (`pk_live_…` for `clerk.cosmaneura.com`) | Sealed native Clerk; never commit |
| `client.upload_origin` (`https://<acct>.blob.core.windows.net`) | Single sealed upload origin |
| `client.workspace_id` (= production `beta_box_id`) | Schema-2 desktop workspace pin |
| Production receiver bindings (`core_origin`, `issuer`, `receiver_origin`, `audience`, `organization_id`, deployment / session-claims / native-policy / protected-data receipt hashes) | Receipt-bound production profile |
| Desktop helper declarations (auth / audio / presentation path + sha256, Store bridge `macho-store-v1` when applicable) | Helper admission pins |
| `--production-native-build-receipt` when the flight plan requires it | Native production compile proof |
| Synthetic production reviewer Clerk user + practice/activation/capture grant | App Review sign-in path |

Until those exist outside git, stop at this documentation + build-number bump.
Do not add placeholder secrets or fake receipts.

---

## 2. Draft Notes for the Reviewer

Paste into App Store Connect → App Review Information → **Notes**. Keep under
Apple’s ~4,000 character limit. Replace angle-bracket placeholders before
submit. Do **not** put PHI or real production passwords in Notes.

```text
Thank you for reviewing Cosmas Scribe.

REGIONS
United States.

REGULATED USE
This app is for licensed clinicians. Practices sign a Business Associate Agreement (BAA) with CosmaNeura before using it with protected health information. Please use only the synthetic demo account and invented patient names.

APP STORE DISTRIBUTION (Guideline 3.2)
Cosmas Scribe is a Mac App Store app for any licensed clinician with a CosmaNeura practice account. It is not a private enterprise build limited to one organization.

WHAT THE APP DOES
Scribe helps a clinician record a visit after patient consent, then prepare a visit note in the CosmaNeura web dashboard. This is the production app. The demo account contains invented data only. Please do not enter real patient information.

AI SERVICES
Server-side processing uses Azure AI Speech for speech-to-text and diarization. When Spanish-to-English translation is admitted for a visit, translation uses Azure GPT-4.1. The Mac app captures and uploads encrypted audio; clinicians review notes in the web dashboard.

SIGN-IN
Sign-in is required. Click Sign in. A secure Clerk browser window opens (ephemeral system browser). Sign in with the demo account in App Review Information (email + password). When the window finishes, return to Scribe. Choose Check access or Open workspace if prompted. You should land on “Today’s patients.”

If you see practice setup or activation messages, the demo account was not pre-activated — contact us using the contact details in App Review Information rather than continuing.

PERMISSIONS (asked only when you set up recording, not at cold launch)
• Microphone — records the clinician-selected microphone after consent.
• Screen Recording — only if you choose “On a video call,” to capture audio from the meeting window you select after consent. Prefer “In the room” (microphone only) for this Review.
In System Settings → Privacy & Security, the app appears as “Cosmas Scribe”. Allow that entry for Microphone (and Screen Recording if you use meeting mode), then return and choose “Check recording access.”

HOW TO RECORD A SYNTHETIC SAMPLE
1. On Today’s patients, choose “+ Walk-in or new patient.”
2. Enter an invented name only, e.g. “Review Test Patient.” Choose “Continue to recording setup.”
3. Choose “In the room” (microphone only).
4. If prompted, choose “Check recording access” / “Set up recording access” and allow Microphone.
5. Read the consent line shown aloud (you may role-play the patient). Check “The patient said yes.”
6. Choose “Start recording.” Speak a few invented sentences (no real clinical details).
7. Choose “Finish visit.” Wait for save/upload. Optional: on Today’s patients, open More → Open the dashboard (may require a second browser sign-in to CosmaNeura notes).

NETWORK
The app needs HTTPS to: production Clerk (hosted sign-in), https://app.cosmaneura.com (catalog, consent, session, upload authority), and one Azure Blob Storage origin for encrypted audio upload. Offline use is not supported.

ACCOUNT DELETION (Guideline 5.1.1(v)) — DONE
In-app Delete account is available in this Mac build (132). Test Delete account with the dedicated throwaway reviewer account only (not the main demo account), so the main demo login survives. Sign-in for that throwaway is in App Store Connect — do not expect its password in these Notes. Sign in with that throwaway → Account → Delete account → type DELETE → confirm. Calls DELETE /v1/me/account. After server confirm, this device wipes local clinical data and signs out. Offline or 401: local clinical data kept; account not deleted. Cancel Scribe access is not account deletion.

DEMO ACCOUNT
Use Sign-in Required credentials for the walkthrough; use the dedicated Delete throwaway only for Delete account. All names and speech must remain synthetic.
```

**Maintainer notes (not for Connect paste):**

- If the demo account is OTP-only, rewrite “(email + password)” in the SIGN-IN
  paste block above.

- Ephemeral system browser:
  `apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/ClerkKitWorkspaceDriver.swift:52-53`
  (`prefersEphemeralWebBrowserSession: true`).
- Sign-in / workspace controls:
  `apps/capture/src/provider/application.ts:129` (“Sign in”),
  `:134-138` (“Check access” / “Open workspace”). Account menu
  (`application.ts`) includes Sign out, **Delete account** (DONE; ships in
  build 132 / Scribe #519 + #563), Cancel Scribe access, and Get help — not
  dashboard.
- Dashboard control on Today’s patients:
  `apps/capture/src/provider/workspace.ts:348` (`More` → `Open the dashboard`);
  opening it may require a second browser sign-in.
- System Settings TCC label for the Store binary public name is **Cosmas Scribe**
  (`PUBLIC_STORE_MAC_NAME` / #558). `preparation-controls.ts:14` only compares
  `document.title` for in-app repair copy — it does **not** prove the System
  Settings TCC label on a signed install.
- Mac account deletion is **DONE** and ships in build **132**: in-app **Delete
  account** for signed-in users (Account → Delete account; Core
  `DELETE /v1/me/account`). After server-confirmed delete, local clinical data
  is wiped and the session ends. Offline/unconfirmed failures and `401` keep
  local clinical data and do not delete the account (`401`: keep-session copy +
  credential clear for re-auth; no clinical wipe) — Scribe #519 + #563.
  **Cancel Scribe access** cancels Scribe capture access only and must **not**
  be described to Apple as account deletion.
- Usage-description strings (packaging drafts, not a checked-in app
  `Info.plist` on this branch):
  `scripts/prepare-desktop-mas-variant.py:74-75` and
  `scripts/prepare-desktop-mas-xpc-variant.py:129-134`
  (`NSMicrophoneUsageDescription` /
  `NSScreenCaptureUsageDescription`).
- Meeting-mode unit coverage (keeps Screen Recording wording allowed in Notes):
  `apps/capture/src/provider/desktop-consent-preparation.test.ts`,
  `desktop-audio-preflight.test.ts`, `consent-preparation.test.ts`.

**Character count (template above, including labels):** keep the filled Notes
under ~4,000 characters. Credentials go only in the App Review Information
sign-in fields, never in Notes.

---

## 3. App Review Information field checklist

Fill in App Store Connect for the **Mac** app version under review. Values below
are instructions or placeholders — never commit real secrets.

| Field | What to fill |
| --- | --- |
| **Name / Subtitle / Keyword / Description / Screenshots** | See § Metadata — name **Cosmas Scribe**; subtitle **Record and review visit notes**; still remove “Mac” from Description and check Screenshots (cautious practice). |
| **Regions** | **United States** |
| **Sign-in required** | **Yes** (checked). The Mac app is unusable for Review without Clerk sign-in. |
| **User name** | `<REVIEWER_SYNTHETIC_EMAIL>` — main demo (John; synthetic only) for the walkthrough. Apple Delete throwaway is separate (`<REVIEWER_DELETION_TEST_EMAIL>`; John or the Beta Tester creates it, with John’s approval) — never put its password in Notes, this doc, chat, or logs. |
| **Password** | `<REVIEWER_SYNTHETIC_PASSWORD>` — main demo in App Store Connect Sign-in Required / private store; **never commit real passwords to git**. Apple Delete throwaway password: App Store Connect sign-in fields + private password store only — never Notes, this doc, chat, or logs. |
| **Contact information — First name** | `<CONTACT_FIRST_NAME>` (founder contact who can answer within Review hours). |
| **Contact information — Last name** | `<CONTACT_LAST_NAME>` |
| **Contact information — Phone number** | `<CONTACT_PHONE_E164>` — reachable during Review. |
| **Contact information — Email address** | `<CONTACT_EMAIL>` — monitored; not necessarily the demo login. |
| **Notes** | Paste the draft in §2 after replacing placeholders. About badge on this binary must show Production (**P**). |
| **Attachment** | Optional. Recommended: short screen recording or PDF of the synthetic walk-in → consent → Finish visit path (no PHI, no real credentials on screen). Filename e.g. `scribe-mac-review-walkthrough.pdf`. Attach in App Store Connect only — do not commit binary media with credentials into git. |
| **Export compliance / encryption** | Follow existing App Store Connect answers for this app; this doc does not change them. |
| **Advertising Identifier** | N/A unless the binary uses IDFA (Scribe Mac does not advertise). |

**Pre-submit smoke (founder; production-sealed signed build 132):** cold launch →
Sign in with the exact App Review main-demo credentials → Today’s patients →
walk-in → mic permission → consent → short synthetic recording → Finish visit →
upload completes. Then sign out, sign in with a **separate team** Delete smoke
throwaway (`<TEAM_DELETION_SMOKE_EMAIL>` — not Apple’s Review throwaway), run
**Account → Delete account** (type DELETE → confirm) once, and confirm local
wipe / signed-out state. Also complete the #552 Try again path and #558
install-over-old-app checks before upload. If launch fails, do not submit; that
is the separate 2.1(a) launch-fix track (**root cause still unconfirmed**).
**Before each Review:** John or the Beta Tester creates a fresh Apple Delete
throwaway, with John’s approval; keep the main demo. Apple deletes that
throwaway during Review; our team never deletes it.

---

## 4. Code changes needed to support a demo path (not implemented here)

Default recommendation needs **no Mac product code change** if the synthetic
production account is fully provisioned. Path B (in-app demo mode) remains
unimplemented and is not selected for this submission.

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

Copy the block below into a Codex (or founder) task. Agents without Clerk/Azure
dashboard access cannot execute these steps.

```text
TASK: Provision Mac App Store Review synthetic access (PRODUCTION — John’s 17 Nov pick)
OWNER: John
REPO CONTEXT: cosmaneura-scribe docs/app-review/mac-app-review-information.md
BUILD: marketing 1.0 / CFBundle build 132 (desktop-release.json)
DO NOT: merge PRs; touch App Store Connect submit/reply without the signed-build
checks; put real passwords in git; use PHI; edit codex/* branches you do not own;
invent production-inputs placeholders in the repo.

GOAL
Leave a Cosmas Scribe Mac App Store build 132 sealed to production that a
stranger can: launch → Clerk Sign in → Today’s patients → walk-in synthetic
patient → mic consent → short recording → Finish visit → encrypted upload,
without practice-setup walls. Listing name must not include “Mac” / “for Mac”.

STEPS
1) Assemble with the existing founder production path only:
   - scripts/assemble-production-provider.py --i-am-john-unlocking-production
   - --production-inputs <founder-held JSON> --enable-production-clients
   - coreOrigin https://app.cosmaneura.com
   - Clerk https://clerk.cosmaneura.com (pk_live_ publishable key; never in git)
   - provider-profile enabled true
   - About / public release badge shows Production (P)
   - MAS/XPC helpers and sandbox entitlements match the submitted package
   STOP if any production-inputs field is missing — do not invent values.
2) In production Clerk, create a dedicated synthetic user:
   - Email: choose a disposable reviewer mailbox you control
   - Enable a password factor Apple can type (preferred) or document OTP
   - Do not reuse personal founder login in App Store Connect
   - Store credentials only in 1Password / App Store Connect — never in git
3) In Cosmas/Core production:
   - Attach that Clerk subject to an active synthetic practice (invented name)
   - Grant provider/workforce role needed for catalog + walk-in creation
   - Complete practice onboarding so Mac will not show “Complete practice setup”
   - Complete Scribe activation so Mac will not show “Finish Scribe activation”
     (Mac lacks those buttons; browser or iOS setup UI is required)
   - Enable Scribe capture capability / cohort for desktop on that practice
   - Ensure cancellation status is not blocking new recordings
4) Azure / upload:
   - Confirm blob account origin matches the package uploadOrigins entry
   - Confirm managed-identity / workload path can authorize block-blob put for
     a synthetic capture (no SAS strings in chat or git)
5) Network:
   - From a clean Mac (not office-only allowlist), verify HTTPS to Clerk, Core, blob
6) Signed-build checks before upload:
   - #552 real Try again path on this signed package
   - #558 install-over-the-old-app + Safe Storage name unchanged
7) Dry run with the exact App Review credentials:
   - Sign in → Check access / Open workspace → + Walk-in → invented name →
     In the room → Check recording access → The patient said yes →
     Start recording → speak synthetic lines → Finish visit → confirm upload/save
8) Fill App Store Connect App Review Information using the checklist in
   docs/app-review/mac-app-review-information.md (§3) and Notes (§2), including
   Regions = United States, regulated/BAA line, Guideline 3.2 public distribution
   line, and Azure AI Speech / Azure GPT-4.1 AI naming.
9) Do not submit or reply to Apple until the separate launch-fix (2.1(a))
   is verified on the same binary (root cause still unconfirmed).

DONE WHEN
Dry run succeeds on the candidate Mac package with only synthetic data, both
signed-build checks pass, and App Review fields are ready for John to paste
(credentials still outside git).

ACCOUNT DELETION — DONE
In-app Delete account is available on Mac and ships in build 132 (Account →
Delete account; Core `DELETE /v1/me/account`; same as iPhone via Scribe #519 +
#563). Server-confirmed delete wipes local clinical data and signs out;
offline/unconfirmed and `401` keep local clinical data and do not delete the
account.
```

---

## 6. Source map (for maintainers)

| Topic | Location |
| --- | --- |
| MAS / Electron entries | `apps/desktop-companion/standalone/main-mas.mjs`, `main-mas-xpc.mjs`, `main.mjs` |
| Sealed staging/production profile | `apps/desktop-companion/src/standalone-provider-profile.ts` (`STAGING_WORKSPACE` L3; schema-1 pin L25) |
| Founder production assemble | `scripts/assemble-production-provider.py`; projection `scripts/standalone-provider/prepare_production_profiles.py` |
| Standalone host (no practice setup wire) | `apps/desktop-companion/src/standalone-provider.ts` (`workspaceId` use L55, L73-76) |
| Desktop UI host | `apps/capture/src/provider/desktop-application.ts` |
| Session / Sign in UI | `apps/capture/src/provider/application.ts` (Account menu; Sign in; Check access / Open workspace); Delete account DONE in build 132 via Scribe #519 + #563 (`account-self-delete.ts`, `purge-local-clinical.ts`, native owners) |
| Today’s patients → More → dashboard | `apps/capture/src/provider/workspace.ts:348` |
| In-app repair-copy app name (not the System Settings label) | `apps/capture/src/provider/preparation-controls.ts:14,75,80` |
| Store public display name | `apps/desktop-companion/src/public-app-release.ts` (`PUBLIC_STORE_MAC_NAME` = Cosmas Scribe) |
| iOS practice/activation (parity reference) | `apps/capture/src/provider/native-application.ts` |
| Clerk hosted sign-in (ephemeral browser) | `apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/ClerkKitWorkspaceDriver.swift:52-53` |
| Clerk `pk_test_` / `pk_live_` prefix | `apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/NativeClerkConfiguration.swift:110` |
| Mic / screen permission helper entry | `apps/desktop-companion/native/ScribeDesktopAudio/Sources/ScribeDesktopAudioHelper/Main.swift` |
| MAS usage-description drafts | `scripts/prepare-desktop-mas-variant.py:74-75`; `scripts/prepare-desktop-mas-xpc-variant.py:129-134` |
| Consent / walk-in copy | `apps/capture/src/provider/recording-preparation-view.ts`, `encounter-setup-view.ts`, `workspace.ts` |
| AI services | ADR 0008 (Azure AI Speech); ADR 0039 (Azure GPT-4.1); `docs/PLAN.md` |
| MAS packaging ADR | `docs/adr/0080-dormant-mac-app-store-distribution.md` |
| Repo-pinned release build (132) | `apps/desktop-companion/desktop-release.json` |
| Install-over-old-app check | `docs/mac-app-store-public-display-name.md` |

---

## Risk class

**Tier 0 for the documentation + build-number stamp** (no runtime unlock in this
PR; production assemble remains founder-gated). Executing the Codex task
(Clerk/practice/capability + production-inputs) is **Tier 2** operational work
under founder authority and is outside this PR. Cloud agents cannot run the Mac
Swift merge filter `swift test --filter NativeDesktopStoreContainerTests` (plain
or `-DSCRIBE_MAC_APP_STORE_XPC`); Beta runs that on a Mac after push.
