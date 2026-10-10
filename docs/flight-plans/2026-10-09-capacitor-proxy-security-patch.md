# Capacitor proxy security patch - Tier 2

Owner authorized the Capacitor upgrade and performance qualification, with the
explicit requirement to preserve the completed recording-start optimizations.

Pin the four existing Capacitor npm packages and all native/peer boundaries to
8.5.1, the first fixed release for GHSA-rvm3-566m-v7fv. Do not run audit fix or
upgrade unrelated dependencies. Match the Xcode/CLI wrapper to the existing
documented iOS 17 recording-plugin floor; do not raise it to the tooling OS.

Compare the final candidate with the owner's performance baseline and current
merged main. All recording-start, token, provider, PCM, consent and desktop
runtime sources must remain byte-identical. Structured lock comparison must
show only the four Capacitor packages and their workspace dependency pins
changed. Record exact tested/reviewed SHA, commands, results and limitations in
the PR. Local implementer review follows the owner's September 25 policy.

Qualification includes production npm audit, JavaScript tests/coverage,
lint/types, browser tests, repeatable Android/iOS sync, iOS app build and hosted
native storage tests. Synthetic cold/repeat/resume timings are structural
regression evidence, not physical microphone, network or full-app acceptance.
Separate Mac and iPhone hardware probes must retain only timing metadata and
discard audio. Their test-only adapters may not be shipped or represented as
the full Scribe consent/identity/encrypted-recording workflow.

Keep the security PR draft until applicable native-platform and physical
regression evidence is recorded. Do not modify an installed Scribe application,
its data, another checkout or a deployment to conduct qualification. Existing
release configuration and founder-only promotion boundaries stay unchanged.

Recovery is to hold distribution and preserve current installed applications.
Prefer a reviewed forward repair; reverting the dependency fix reintroduces a
critical vulnerability and requires an explicit security-risk decision. This
change performs no migration, live-data write or automatic deployment.
