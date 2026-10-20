# Store bridge code layout

Tier 2: the packaged native-helper path is a main-process integrity boundary.

Store103 reached bootstrap stage 7 and reported Bridge category 10/exit 70.
That category is `XPC_ERROR_CONNECTION_INVALID`, from either the connection
event or reply callback. It does not establish which namespace or service
admission step failed. This change corrects the documented code placement; it
does not claim a runtime fix for that observation.

Apple lists `Contents/MacOS` and `Contents/Helpers` as locations for helper
tools. The Store bridge was in `Contents/Resources/app/native`. The canonical
XPC preparer now declares and exclusively places the bridge at
`Contents/MacOS/ScribeStorePipeBridge`. It rejects an existing target or a stale
copy at the old resource location and retains the bridge bytes.

The Store factory accepts only that literal declaration for all three roles,
with the same SHA-256. It derives the target from the canonical package root
and requires the running Store executable to belong to that exact app. Native
byte verification remains before acquisition. The Direct distribution retains
its existing relative-path parser and error semantics.

Native service IDs, parent ID, Team, sandbox claims, Keychain group, shared
fence group, authenticated peer/Boolean/kernel-parent checks, descriptor
grammar, and stop/drain gates are unchanged. A local comparison found all 70
declared native compile inputs equal to the retained Store103 receipt; the
changed preparer is packaging metadata outside that set. Fresh preparation and
an independently reviewed producer receipt must still bind any later reuse.

Validation exercises the real factory with synthetic bundle files and a mocked
native acquisition, plus exclusive placement with synthetic bytes. It does not
launch an app, helper, SDK or XPC service. Independent review binds the final
source. Producer execution, signing and runtime qualification require their
separate existing release controls. Preserve the Store103 artifacts and receipts
as the prior candidate; do not overwrite installed Direct97 or user data.

Primary references:

- [Apple bundle code placement](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle)
- [Apple code-signing locations](https://developer.apple.com/library/archive/technotes/tn2206/)
- [Apple bundled XPC service structure](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html)
