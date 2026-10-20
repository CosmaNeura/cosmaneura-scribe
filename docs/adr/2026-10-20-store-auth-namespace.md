# Separate Store auth namespace

Decision: retain the existing ASC parent and give its Store auth XPC helper a
distinct signed bundle ID and one exact credential group. Use a separate Store
fence group, product name and local userData child. The direct app keeps its
existing credentials and recordings; no implicit session or data migration occurs.

The current Clerk SDK exposes a configurable primary service/group, but also
uses bundle-derived recovery/installation services and fixed biometric tags.
A distinct auth bundle covers those complete query families while the exact
single signed group confines Data Protection biometric queries. Patching only
the primary service would leave the previous identity/recovery paths shared.
The vendor source lock remains unchanged.

The [flight plan](../flight-plans/2026-10-20-store-credential-namespace.md)
records exact identities, profile authorization, recovery ordering and the actual
signed qualification still required. Compilation is source readiness only.
