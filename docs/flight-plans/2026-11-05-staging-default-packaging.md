# Staging-default provider packaging — Tier 2

Normal standalone, disabled desktop and iOS review preparation must produce
staging configuration. Before creating output, inspect iOS/desktop profiles,
Info.plist auth blocks, copied configuration and native compile receipts for
live Core, live Clerk, live-key prefixes and the production compile definition.
Keep the native identity and transport refuse gates and receipt validation.
Synthetic offline fixtures prove refusal without installing or contacting services.

The normal assembler requires the approved disabled P1 staging iOS profile.
An omitted application origin retains the native fixed staging binding; any
supplied origin must be exactly `https://staging-app.cosmaneura.com`. Mac About
shows Staging (S) or Production (P) from `provider-profile.json` coreOrigin even
without release metadata. The sealed iOS Info.plist display name is `Scribe S`
or `Scribe P`; numeric marketing/build versions and bundle identity remain valid.

Founder only. Not for agents. Not the default. John deliberately uses
`scripts/assemble-production-provider.py --i-am-john-unlocking-production`
with `SCRIBE_FOUNDER_PRODUCTION_UNLOCK=1` set in that shell, the existing
`--production-inputs`, `--production-native-build-receipt` and normal build paths.
`--enable-production-clients` retains its existing receipt-bound behavior.
The same env/flag pair is required for `build-desktop-native-provider.py
--production-organization` and `standalone-provider/prepare_production_profiles.py`.
The env var alone never changes classification or unlocks the normal assembler.
This deliberate latch is founder self-authorization, not identity verification;
it grants no deployment, signing, installation or Apple upload authority.

No running service, cohort, schema/data, auth policy, Actions setting, production
receiver or App Store metadata changes. Deployed-state reconciliation, migration
and feature-flag rollout are N/A for this offline packaging change. Hold at the
draft PR and require independent non-implementer review of the last pushed SHA.
Physical-device installation and founder production receipts remain separately
qualified; fixture success is not installed-build or production qualification.

Recovery before release: discard the unsigned candidate and hold this PR.
After adoption, retain the previous reviewed package and saved data; fix a
preflight false positive with a reviewed follow-up rather than weakening guards
or redirecting production to staging. No merge or promotion is part of this update.
