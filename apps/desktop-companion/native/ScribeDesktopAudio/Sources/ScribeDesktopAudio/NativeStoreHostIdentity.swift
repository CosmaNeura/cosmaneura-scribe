#if SCRIBE_MAC_APP_STORE_XPC
import Foundation
import Security

/// Native-only identity retained after the XPC listener binds the bridge's
/// kernel parent. A presentation field or window ID cannot construct authority.
@MainActor public final class NativeStoreHostIdentity {
    let process: Int32
    private let code: SecCode
    private let requirement: SecRequirement
    public init(authenticatedProcess process: Int32) throws {
        guard process > 1, let group = NativeDesktopStoreContainer.approvedApplicationGroup else {
            throw ProviderPresentationFailure.unavailable
        }
        var code: SecCode?, requirement: SecRequirement?
        let text = "anchor apple generic and identifier \"com.cosmaneura.scribe.beta.desktop\" and certificate leaf[subject.OU] = \"JVV65668U6\" and entitlement[\"com.apple.security.app-sandbox\"] = true and entitlement[\"com.apple.security.application-groups\"] = \"\(group)\""
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              let requirement,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: process] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
            throw ProviderPresentationFailure.unavailable
        }
        self.process = process; self.code = code; self.requirement = requirement
    }
    var isValid: Bool { SecCodeCheckValidity(code, [], requirement) == errSecSuccess }
}
#endif
