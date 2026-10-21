# Separate Store auth namespace

Decision: retain the existing ASC record, use the Store-only parent bundle ID
`com.cosmaneura.scribe.beta.desktop.store`, and give its Store auth XPC helper a
distinct signed bundle ID and one exact credential group. Use a separate Store
fence group, product name and local userData child. The direct app keeps its
existing credentials and recordings; no implicit session or data migration occurs.

The first Development-signed Store candidate stopped before JavaScript startup:
Electron's `bootstrap_check_in` requested the old parent Mach namespace and was
denied. Electron 44.4.3 derives that namespace from the actual Team ID and parent
bundle ID. The Store-only parent now matches the existing single Store group;
no legacy shared-container group or Mach exception is granted. Apple permits the
same App Store record's bundle ID to change before its first build upload.
The direct parent, native auth/audio/presentation IDs and new Store data paths
remain unchanged. Actual signed startup qualification is still required.

The current Clerk SDK exposes a configurable primary service/group, but also
uses bundle-derived recovery/installation services and fixed biometric tags.
A distinct auth bundle covers those complete query families while the exact
single signed group confines Data Protection biometric queries. Patching only
the primary service would leave the previous identity/recovery paths shared.
The vendor source lock remains unchanged.

The [flight plan](../flight-plans/2026-10-20-store-credential-namespace.md)
records exact identities, profile authorization, recovery ordering and the actual
signed qualification still required. Compilation is source readiness only.
