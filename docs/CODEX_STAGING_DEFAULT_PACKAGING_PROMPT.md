# Codex prompt — staging-default packaging (paste into Codex on John’s Mac)

Build 94 pointed at live Cosmas when we needed staging. Fix the Mac packaging so the normal path can only make staging builds. Production packaging stays behind a separate unlock only you run. When you are done, a staging assemble that names the live API or live sign-in must fail on the spot, and every installed build must show S or P so a wrong install is obvious.

---

Copy everything below this line into Codex.

---

## Role

You are working in the local `cosmaneura-scribe` checkout on John’s Mac. Implement three packaging guards for the iOS + Mac standalone provider. Synthetic data only. No secrets in code, receipts, chat, or commits. Do not touch App Store Connect, production Azure, live Clerk dashboards, CosmaBot (`cosmaneura-os`), or any `codex/*` branch you did not create for this task. Do not merge. Do not force-push. Do not weaken or disable existing CI.

## Goal (three deliverables)

### A. Staging-only default packaging

Normal assemble/build scripts must emit staging-bound builds only:

| Binding | Staging (default) | Production (unlock only) |
|---|---|---|
| Core / Cosmas API | `https://staging-app.cosmaneura.com` | `https://app.cosmaneura.com` |
| Clerk sign-in | `https://resolved-emu-53.clerk.accounts.dev` (`pk_test_`) | `https://clerk.cosmaneura.com` (`pk_live_`) |
| Receiver profile | `core-staging-https-v1` | `core-production-*-https-v1` |
| Compile flag | **absent** | `-DSCRIBE_PRODUCTION_ORGANIZATION` |

Requirements:

1. Default path of `scripts/assemble-standalone-provider.py` (and `scripts/assemble-disabled-desktop-candidate.py`) continues to require the approved disabled staging iOS profile and staging `coreOrigin`. Refuse if callers omit the staging profile and try to slip in production inputs without the unlock.
2. Add a **founder-only production unlock** entry point John runs deliberately, for example:
   - `scripts/assemble-production-provider.py` **or** a clearly named wrapper that calls the existing production path, **and**
   - requires both an explicit CLI flag (e.g. `--i-am-john-unlocking-production`) **and** an env var John sets in that shell only (e.g. `SCRIBE_FOUNDER_PRODUCTION_UNLOCK=1`).
3. Without that unlock, `--production-inputs`, `--enable-production-clients`, `--production-organization`, and `-DSCRIBE_PRODUCTION_ORGANIZATION` must be refused with a clear error. Keep using existing receipt checks in `prepare_production_profiles.py` / assembler; do not invent a weaker path.
4. Document the unlock in a short comment at the top of the production entry script: “Founder only. Not for agents. Not the default.”

### B. Build refuse rule

Staging and qualification builds must **fail at build/assemble time** if they reference:

- live Cosmas API host: `https://app.cosmaneura.com`
- live Clerk: `https://clerk.cosmaneura.com` or any `pk_live_` key material in the staged payload

Implement a preflight (prefer extending assemble + a small shared helper used by assemble and desktop native build) that scans the **payload about to be written** (iOS `StandaloneBuildProfile.plist`, desktop `provider-profile.json`, compile definitions, Info.plist auth blocks). If the build is classified staging/qualification (no production unlock) and any live marker appears → raise and leave no output directory.

Keep existing Swift refuse gates (`NativeClerkConfiguration.swift`, `NativeTokenPolicy.swift`, `ProviderNativeTransport.swift`, `DesktopProviderMain.swift`). Do not remove them. The new check is an earlier, mechanical stop for packaging.

Qualification means: App Review / TestFlight / staging cohort packages, disabled P1 staging profile, virtual-lab staging auth, and any assemble that is not the founder production unlock.

### C. Visible Staging vs Production marker

Installed builds must make the environment obvious:

1. **Mac About / version line:** include `S` or `P` derived from `coreOrigin` (not independently selectable). Example shape: `Build 95 · Direct beta · Staging (S)` / `… · Production (P)`. Prefer extending `apps/desktop-companion/src/public-app-release.ts` and its tests (`scripts/public-app-release.test.mjs`) so the marker stays tied to `coreOrigin`.
2. **iOS / provider chrome:** stamp a visible `S` or `P` into the marketing/version display or a persistent non-overlay banner/label in the provider UI for staging vs production profiles. Derive from the sealed profile / `coreOrigin`, never from a free-floating flag. Touch the smallest surface that is visible after install (assemble-time Info.plist display string and/or provider startup chrome in `apps/capture/src/provider/`).
3. Marker must be wrong-install-obvious on a phone or Mac without opening developer tools.

## Exact files to change (expected)

Touch only what the three goals need. Likely set:

- `scripts/assemble-standalone-provider.py`
- `scripts/assemble-disabled-desktop-candidate.py`
- New: `scripts/assemble-production-provider.py` (or equivalent founder unlock wrapper)
- New: shared preflight helper under `scripts/standalone-provider/` (e.g. `refuse_live_hosts_in_staging.py`)
- `scripts/build-desktop-native-provider.py` (refuse `--production-organization` without unlock)
- `apps/desktop-companion/src/public-app-release.ts` (+ existing tests)
- Provider UI / assemble stamp for iOS visible marker (minimal path in `apps/capture/src/provider/` and/or assemble Info.plist fields)
- Existing Swift refuse files only if a staging compile path can still accept live hosts — prefer assemble preflight first
- Short note in `docs/` only if needed to describe the unlock (no long essay)

Do **not** edit App Store metadata, production Azure/OpenTofu apply paths, or CosmaBot.

## Acceptance checks

1. **Default assemble → staging only.** Running the normal assemble instructions (staging iOS profile, no production flags) produces `coreOrigin: https://staging-app.cosmaneura.com`, Clerk `resolved-emu-53`, receiver `core-staging-https-v1`, and visible **S**.
2. **Staging assemble refuses live host.** With a deliberately poisoned staging profile (or temp plist) that sets `frontendOrigin` to `https://clerk.cosmaneura.com` or `coreOrigin` to `https://app.cosmaneura.com`, assemble **exits non-zero** and writes **no** output payload. Capture the error text.
3. **Production path locked.** Without `SCRIBE_FOUNDER_PRODUCTION_UNLOCK=1` and the deliberate flag, `--production-inputs` / `--production-organization` fail. With unlock + existing receipt requirements, production assemble still works for John and stamps **P**.
4. **Tests.** Unit/preflight tests cover: clean staging OK; poisoned staging refused; founder allow path not used by default. Synthetic fixtures only.
5. **No secrets.** No `pk_live_` material, tokens, or patient data in the branch.

## How to prove it (do this and paste evidence in the PR)

```bash
# 1) Clean staging assemble (use your usual local staging profile path)
python scripts/assemble-standalone-provider.py …   # your normal staging args
# Expect: provider-profile.json coreOrigin staging-app; visible S on About / UI

# 2) Poisoned staging profile must fail
# Copy the staging plist, set CosmasNativeAuth.frontendOrigin to
# https://clerk.cosmaneura.com (or coreOrigin to https://app.cosmaneura.com),
# run the same assemble command against that copy.
# Expect: non-zero exit, clear refuse message, no output directory created.

# 3) Production unlock required
# Attempt production assemble/build WITHOUT the unlock env+flag → must fail.
# With unlock + existing receipts → P marker; do not upload to App Store Connect.
```

Open a draft PR from a new branch named `codex/staging-default-packaging-YYYYMMDD` (not `main`, not an existing `codex/*` branch owned by another task). Tier: treat host-binding / packaging unlock as **Tier 2**. Independent non-implementer review after the last substantive push. Do not merge.

## Out of scope

- Making the GitHub `staging-build-hosts` check required (John does that in the ruleset UI).
- Rewriting `AGENTS.md`.
- Deploying or promoting anything.
- Changing live Clerk instances or production receivers.
