#if SCRIBE_MAC_APP_STORE_XPC
import Foundation
import XCTest
@testable import ScribeDesktopAudio

@MainActor final class NativeStoreHostIdentityTests: XCTestCase {
    func testSignedSandboxRequiresAnActualTrueBoolean() {
        XCTAssertTrue(NativeStoreHostIdentity.booleanIsTrue(kCFBooleanTrue))
        let rejected: [Any?] = [nil, kCFBooleanFalse, "true", "false", 1, 0, NSNumber(value: 1),
                               [true], ["value": true], Data()]
        for value in rejected {
            XCTAssertFalse(NativeStoreHostIdentity.booleanIsTrue(value))
        }
    }
}
#endif
