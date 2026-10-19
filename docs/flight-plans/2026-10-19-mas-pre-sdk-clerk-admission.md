# Read-only Mac store Clerk admission

Risk: Tier 2. Owner: founder. This source-only successor preserves the frozen
formatted XPC tree and installed direct distribution. No merge, activation,
SDK/service/helper launch, real preferences/Keychain access, migration, signing,
account/profile changes, installation or capture is included.

The XPC-only auth composition reads the exact retained Clerk installation-marker
key for service `com.cosmaneura.scribe.beta.desktop.auth.clerk`, nil explicit
access group and app identifier `com.cosmaneura.scribe.beta.desktop.auth`.
Only a true Boolean admits composition. Missing, false, malformed and thrown or
protected/unknown reads reject before the access block or Clerk driver exists.
The reader has no write operation and there is no cleanup or reset fallback.
The direct and older nil-gated store variants retain their existing composition.

Injected pure checks count driver, cleanup and access-block construction, verify
zero calls for every rejected state and check the fixed namespace. Real provider
typechecking covers both direct and XPC compilation. Source evidence binds the
retained Clerk driver and installation-key implementation; no SDK is initialized.

This gate prevents the known missing-marker cleanup path. A true marker alone
does not prove authentic legacy migration, account compatibility, old source-owner
exclusion or new fence-anchor custody. A fresh sandbox with no marker deliberately
fails closed; separately reviewed clean-install or migration admission remains
required before runtime qualification. Recovery is to retain the prior dormant
source and direct app; never fabricate the marker or run SDK cleanup as a probe.
