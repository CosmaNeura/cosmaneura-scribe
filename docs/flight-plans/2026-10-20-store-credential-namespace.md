# Store auth namespace and coexistence

Tier 2: auth/session and storage boundary. This change is confined to the explicit
`--mac-app-store-xpc` build. It retains the existing ASC record and uses the
Store-only parent `com.cosmaneura.scribe.beta.desktop.store`. The direct parent
`com.cosmaneura.scribe.beta.desktop` and audio/presentation service IDs remain
unchanged. Native authentication uses
`com.cosmaneura.scribe.beta.desktop.store.auth` for native authentication. The
direct build retains its original auth ID and default Clerk access-group policy.

The Store auth executable receives exactly
`JVV65668U6.com.cosmaneura.scribe.beta.desktop.store.auth` as its only Keychain
access group. Clerk's configured service, previous bundle service, installation
marker, stable installation identity and clear-recovery journal all derive from
the new auth bundle. Its primary storage receives the new group explicitly.
Clerk's fixed biometric tags use Data Protection Keychain queries without an
explicit group; the executable's one permitted group confines those queries to
the new namespace. The locked vendor SDK is unchanged. Scribe's local access
block and source journal also use the new exact group and Data Protection
Keychain. No old credential group is granted to any Store process.

All four Store roles use the separate fence-only application group
`JVV65668U6.com.cosmaneura.scribe.beta.desktop.store`. It grants no shared Keychain
access. Electron uses `Cosmaneura Scribe Store` beneath its OS-provided appData
directory. The Store path neither opens the direct app's userData nor imports its
source journal/fence. Old records and credentials remain accessible in the direct
app. Store authentication uses the normal sign-in flow; there is no silent session
adoption or data migration.

The first Development-signed Store candidate failed before JavaScript startup
with `bootstrap_check_in` permission denied for the old parent Mach namespace.
The [Electron 44.4.3 guide](https://github.com/electron/electron/blob/v44.4.3/docs/tutorial/mac-app-store-submission-guide.md)
and [bundle setup source](https://github.com/electron/electron/blob/v44.4.3/shell/app/electron_main_delegate_mac.mm)
require the actual Team ID and parent bundle ID to match the application's Mach
group. The new Store parent matches the already isolated Store group. Adding the
legacy group would also grant its shared-container authority, so it is excluded.
The four native parent/bridge signature requirements now accept only this new
Store parent; service identities, descriptors, lifetime and peer checks remain
fixed. Apple's App Information rule allows changing the existing record's bundle
ID before its first upload; that owner action and new parent profiles precede
signed qualification. The failed candidate and its receipts remain preserved.

The Store product name is also distinct. Its entry explicitly selects that name
at the packaged-host gate; the direct entry still accepts only the Beta name.
Existing userData links or broad permissions fail without repair, before opening
the provider. Signed qualification must verify the Store parent safeStorage
service attribution as well as the new native auth namespace.

Before Clerk construction, the auth service verifies its exact signed role
claims and resolves the OS Store container. It loads only its own source journal,
acquires coordinator/capture locks, and persists the stable anchor. Capture stays
locked until the existing authenticated stop-only recovery confirms and removes
each pending Store owner. Missing, unreadable, changed or legacy anchors fail
closed; they are never reset to allow sign-in. Account/consent, encrypted recording,
Stop/drain, native indicator and parent-window gates are unchanged.

The new auth App ID needs Development and Mac App Store profiles. The existing
auth profile is exact to the old ID and cannot sign it. A new registered
`group.com.cosmaneura.scribe.beta.desktop.store.profile.authorization`, assigned
only to the new auth App ID, can authorize profile generation; it is not a
compiled entitlement. Verified CMS profile claims must admit the new exact App ID,
Keychain group and Team-ID fence group. The source checker validates those three
authorization relations; the release operator separately verifies CMS trust,
expiration, profile type, certificate and actual signed claims. The new Store
parent needs its own Development and Mac App Store profiles; it requires no new
capability beyond the retained exact role claims. Audio/presentation and auth
profiles remain compatible because those IDs are unchanged.

Source compilation and fake-storage/filesystem tests do not qualify OS Keychain,
sandbox/container attribution, XPC peer checks, hosted sign-in, simultaneous
installed-app coexistence, or capture/save/review. Those actual signed checks must
pass before promotion. Public clinical/production acceptance remains separate.
Rollback before Store promotion preserves the installed direct app. If Store
qualification fails, preserve its new records for review and return to the direct
app; do not erase either namespace, reset TCC or migrate credentials as recovery.

An independent non-implementer review after the last substantive push is required
before merge. Record exact source/build hashes, test counts and remaining runtime
qualification in the PR and release receipt.
