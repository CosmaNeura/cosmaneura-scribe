# Dormant Mac App Store build inputs

Tier 2, owner: founder; source preparation only. This is a separate checkout
based on merged PR356; Developer ID Desktop94/95 and their receipts stay frozen.
The initial cohort is empty. Review dormant source/Apple identity inputs before
November 15, 2026. No store artifact is selectable from this work yet.

Prepare a fresh unsigned target using the exact retained Clerk dependency:

```sh
python3 scripts/prepare-desktop-mas-variant.py /tmp/new-mas-inputs \
  --clerk-source /path/to/locked/clerk/vendor
node scripts/build-desktop-provider-host.mjs /path/to/retained/renderer \
  /tmp/new-mas-host --mac-app-store
python3 scripts/build-desktop-native-provider.py /tmp/new-mas-auth \
  --native-auth-source /tmp/new-mas-inputs/native-source/cosmas-native-auth \
  --mac-app-store
```

For the prepared audio Swift package, use `-Xswiftc -DSCRIBE_MAC_APP_STORE` in
the existing unsigned release compiler with owned scratch/cache directories.
Do not launch these binaries: the compiled App Group is absent. Renderer input
must be the retained approved renderer directory; a full current frontend build
must not silently activate the catalog/recovery scope changes on receiver705.
The corresponding official runtime target is Electron44.4.3 `mas` arm64;
archive/checksum/material provenance still needs to be pinned, not guessed.

Before a runnable development artifact exists, the owner needs an approved App
Group for the parent and native helpers, matching Apple development profiles,
and an explicit reviewed compiled identity change. Preserve the existing native
auth group and callbacks. Independently review the final source and unsigned
input inventory. The development qualification must verify native helper launch
and permission attribution, common fence inode/epoch custody, unchanged native
Clerk and journal access, encrypted save/recovery, ordinary background capture
and saved-audio review. Existing source-owner records must fail closed on an
unreconciled anchor; never infer a new installation or reset custody.

App Store submission separately needs actual distribution profiles/certificates,
an installer distribution identity if producing a store package, app record and
version/build, privacy/export/reviewer/screenshots, and physical qualification.
No Apple identity or account is created here; no signed package/upload is implied.
Recovery for this source-only proposal is to continue selecting the unchanged
direct target. No user data migration or installed-app rollback is needed.
