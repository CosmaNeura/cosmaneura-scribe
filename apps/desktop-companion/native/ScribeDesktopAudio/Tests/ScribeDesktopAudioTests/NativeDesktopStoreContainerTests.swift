import Foundation
import XCTest
@testable import ScribeDesktopAudio

final class NativeDesktopStoreContainerTests: XCTestCase {
    private let group = "JVV65668U6.com.cosmaneura.scribe.synthetic.store-check"

    private func claims(_ bundle: String) -> [String: Any] {
        var value: [String: Any] = [
            "com.apple.security.app-sandbox": true,
            "com.apple.security.application-groups": [group],
            "com.apple.developer.team-identifier": NativeDesktopStoreContainer.team,
            "com.apple.application-identifier": NativeDesktopStoreContainer.team + "." + bundle,
        ]
        if bundle == NativeDesktopStoreContainer.auth {
            value["keychain-access-groups"] = [NativeDesktopStoreContainer.team + "." + bundle]
            value["com.apple.security.network.client"] = true
        } else if bundle == NativeDesktopStoreContainer.parent + ".audio" {
            value["com.apple.security.device.audio-input"] = true
            value["com.apple.security.device.microphone"] = true
        }
        return value
    }

    func testUnapprovedCompiledDistributionDoesNotResolveOrCreateAContainer() {
#if SCRIBE_MAC_APP_STORE_XPC
        XCTAssertEqual(NativeDesktopStoreContainer.approvedApplicationGroup,
                       "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store")
#else
        XCTAssertNil(NativeDesktopStoreContainer.approvedApplicationGroup)
        XCTAssertThrowsError(try NativeDesktopStoreContainer.requireContainer())
        XCTAssertThrowsError(try NativeDesktopStoreContainer.fenceDirectory())
#endif
    }

    func testEachNativeRoleMustHaveExactOwnIdentityAndGroup() throws {
        for bundle in NativeDesktopStoreContainer.helpers {
            try NativeDesktopStoreContainer.validateMembership(claims(bundle), bundle: bundle, approvedGroup: group)
            var wrong = claims(bundle)
            wrong["com.apple.application-identifier"] = NativeDesktopStoreContainer.team + "." + NativeDesktopStoreContainer.parent
            XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(wrong, bundle: bundle, approvedGroup: group))
            wrong = claims(bundle)
            wrong["com.apple.security.application-groups"] = [group, "group.extra"]
            XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(wrong, bundle: bundle, approvedGroup: group))
        }
    }

    func testSandboxBooleanCannotBeOmittedFalseOrNumeric() {
        let bundle = NativeDesktopStoreContainer.auth
        for sandbox: Any? in [nil, false, NSNumber(value: 1), "true"] {
            var value = claims(bundle); value["com.apple.security.app-sandbox"] = sandbox
            XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(value, bundle: bundle, approvedGroup: group))
        }
    }

    func testOnlyAuthOwnerReceivesTheExactStoreCredentialGroup() {
        let auth = NativeDesktopStoreContainer.auth
        for access: Any? in [nil, [], [NativeDesktopStoreContainer.team + "." + auth, "group.extra"]] {
            var value = claims(auth); value["keychain-access-groups"] = access
            XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(value, bundle: auth, approvedGroup: group))
        }
        var old = claims(auth)
        old["keychain-access-groups"] = [NativeDesktopStoreContainer.team + ".com.cosmaneura.scribe.beta.desktop.auth"]
        XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(old, bundle: auth, approvedGroup: group))
        for bundle in NativeDesktopStoreContainer.helpers where bundle != auth {
            var value = claims(bundle); value["keychain-access-groups"] = [NativeDesktopStoreContainer.team + "." + auth]
            XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(value, bundle: bundle, approvedGroup: group))
        }
    }

    func testUnrecognizedHelperAndTraversalGroupAreRejected() {
        XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(claims(NativeDesktopStoreContainer.auth),
            bundle: "com.cosmaneura.scribe.beta.desktop.auth.extra", approvedGroup: group))
        XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(claims(NativeDesktopStoreContainer.auth),
            bundle: NativeDesktopStoreContainer.auth, approvedGroup: "../" + group))
    }

    func testExtraFilesystemGrantsOrFalseRolePermissionsAreRejected() {
        let bundle = NativeDesktopStoreContainer.auth
        var extra = claims(bundle); extra["com.apple.security.temporary-exception.files.home-relative-path.read-write"] = ["/"]
        XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(extra, bundle: bundle, approvedGroup: group))
        for network: Any in [false, NSNumber(value: 1)] {
            var value = claims(bundle); value["com.apple.security.network.client"] = network
            XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(value, bundle: bundle, approvedGroup: group))
        }
    }

    func testAudioRequiresBothStrictBooleanPermissions() throws {
        let bundle = NativeDesktopStoreContainer.parent + ".audio"
        try NativeDesktopStoreContainer.validateMembership(claims(bundle), bundle: bundle, approvedGroup: group)
        for key in ["com.apple.security.device.audio-input", "com.apple.security.device.microphone"] {
            for invalid: Any? in [nil, false, NSNumber(value: 1), "true"] {
                var value = claims(bundle); value[key] = invalid
                XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(value, bundle: bundle, approvedGroup: group))
            }
        }
    }

    func testAudioPermissionsCannotBeGrantedToOtherNativeRoles() {
        let audio = NativeDesktopStoreContainer.parent + ".audio"
        for bundle in NativeDesktopStoreContainer.helpers where bundle != audio {
            for key in ["com.apple.security.device.audio-input", "com.apple.security.device.microphone"] {
                var value = claims(bundle); value[key] = true
                XCTAssertThrowsError(try NativeDesktopStoreContainer.validateMembership(value, bundle: bundle, approvedGroup: group))
            }
        }
    }
}
