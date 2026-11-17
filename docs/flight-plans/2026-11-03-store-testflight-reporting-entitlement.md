# TestFlight reporting entitlement compatibility

Tier 2: this is a narrow compatibility repair in the native Store membership check.

The normal Apple TestFlight launch of Mac build 129 reached the authenticated
Store auth helper, then emitted `SCRIBE_STORE_CONTAINER:7` and
`SCRIBE_STORE_AUTH_ENTRY:5`. Its installed signed claims contain Apple's
`beta-reports-active` Boolean `true` in addition to the exact existing identity,
App Group, sandbox, network-client and isolated Keychain claims. The exact-key
membership check rejected that reporting marker before the XPC listener started;
the bridge consequently received `XPC_ERROR_CONNECTION_INTERRUPTED`.

Accept only an optional, strictly typed Boolean `true` reporting marker. Keep
every existing identity, group, role permission and unknown-entitlement rejection.
No entitlement, credential, App Group or Keychain permission is added by this
source change. The distributed signing inputs remain unchanged; Apple supplies
the reporting marker during TestFlight processing.

Validate the installed public claims against the exact source predicate, add
focused role/Boolean/unknown-grant regressions, and rebuild the three Mac Store
Swift services that share the check. The C bridge, receiver, iPhone and Core
sources remain unchanged. After independent source and package review, submit
the next Mac build and verify one normal TestFlight Open. Source or static
package acceptance alone does not qualify that operational gate.

Recovery is the prior immutable package; it retains the known startup failure.
Preserve prior signed artifacts and do not modify installed payloads or broaden
local trust settings to make the failed build run.
