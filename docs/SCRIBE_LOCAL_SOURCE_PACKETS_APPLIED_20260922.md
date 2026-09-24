# Four local source packets applied — 2026-09-22

The owner approved: **“I approve four local source packets.”** This applies the consolidated main source stack, configured workers, receiver executable and desktop native-session correction. The source-adoption approval is fulfilled; historical proposal documents describing it as pending are superseded by this receipt.

The existing checkout and branch were used: `codex/beta-preintegration-20260904`, HEAD `56cc215b0ececfe12375c78c50efd84f897e2b10`. Six ordered patch applications changed 62 Scribe source files after verifying HEAD, branch, existing dirty paths, every preimage, and the reviewed patch hashes. Initial adopted files exactly matched all reviewed manifests. Existing unrelated changes and both protected source files were preserved. Nothing was committed or pushed.

Core/native/identity changes are adopted in the previously reviewed owned release copies. The original Core integration checkout, OS/W13/trial and approved P1 native inputs remain read-only and unchanged. All 82 original Core integration paths and 450 retained client/native source files were checked against their recorded hashes.

## Adopted behavior

- Durable native source-start ownership through shared Core, configured Scribe startup, the real desktop/native backend factory and iOS microphone start gate.
- Separate configured Speech and translation entry points with explicit database-permission bootstrap controls.
- An executable receiver using managed identity, a read-only asynchronous registry, isolated platform verifiers and the existing ACA adapter.
- A separate, false-by-default desktop native-session option for absent azp in the exact staging-personal profile. Source approval does not enable that policy.

One post-adoption build defect was fixed: the desktop helper builder now records sources supplied from the approved external native-auth directory instead of requiring them to be inside the Scribe checkout. Its full native build passed using that external directory. Payload receipt labels were also updated to remove the now-fulfilled source/helper approval requests. These two small packaging changes do not change identity policy or runtime activation.

## Build evidence

The adopted API passes strict type checking across 63 modules. Capture and desktop TypeScript checks and the relevant lint checks pass. The desktop provider renderer, complete desktop host/factory, standalone iOS renderer and native desktop account helper build from the adopted checkout.

A new disabled Electron review application includes those desktop builds plus the unchanged, previously built audio and presentation helpers. It retains Electron's identity and is not a signed Scribe distribution. The rebuilt iOS renderer exactly matches the existing full unsigned iOS archive; that archive's recorded files remain unchanged. All 63 modules in the existing offline API/worker wheel exactly match the adopted API source. The complete receiver Docker context is bound to the adopted receiver/API and approved owned identity sources. No container image was built.

These are local build/adoption results. No completed live provider, audio or device trial was repeated. The local fixture database remains stopped. No staging or installed acceptance is claimed.

## Authoritative receipts and release inputs

- [Actual adoption receipt](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/adoption/source-adoption-receipt.json)
- [Final source/build provenance](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/adoption/validation/adopted-release.json)
- [Two packaging fixes](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/adoption/build-path-and-receipt-fixes.patch)
- [Approved scope](/Users/jw/Desktop/Cosmas/scribe-source-start-20260922.h91ly9kp/RELEASE_REVIEW_20260922.md)

The final provenance receipt gives the exact API wheel, receiver build context, Electron review application, unsigned iOS archive, owned Core source and native/identity source directories. Frozen review packets retain their original bytes as historical evidence.

## Remaining operational work and boundaries

Service, worker, database-bootstrap, client and desktop-policy activation defaults remain off. Tenant/upload lists remain empty and environment binding placeholders remain unfilled. Source adoption made no shared database, account, cohort, cloud configuration, deployment, signing, installed application or Keychain change.

The separate request to read `Staging / Azure staging Postgres Database`, field `python-connection-string`, remains pending. The approved Clerk lookup does not cover it. John's staging Core actor/practice/provider/tenant correspondence, ciphertext upload host, workload identities and ingress isolation must still be verified before an explicit staging activation and installed desktop/mobile qualification. Issued-but-unconfirmed start/orphan recovery remains unfinished. Existing Core remains the authority for users, encounters, notes and the dashboard.
