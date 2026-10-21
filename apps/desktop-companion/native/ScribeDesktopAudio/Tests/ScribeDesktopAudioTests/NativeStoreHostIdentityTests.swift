#if SCRIBE_MAC_APP_STORE_XPC
import Foundation
import XCTest
@testable import ScribeDesktopAudio

/// Synthetic handles are consumed only by the internal wrapper seam. These
/// callbacks never create a native lease, activate XPC or inspect a process.
private final class StoreHostLeaseProbe {
    let handle = OpaquePointer(bitPattern: 0x4141)!
    var permitsRetain = true
    var parent: Int32 = 4242
    var revoked = false
    var retainCalls = 0, releaseCalls = 0, parentCalls = 0, currentCalls = 0

    var operations: NativeStoreHostLeaseOperations {
        NativeStoreHostLeaseOperations(retain: { [self] raw in
            retainCalls += 1
            return permitsRetain && raw == handle ? handle : nil
        }, release: { [self] raw in
            XCTAssertEqual(raw, handle); releaseCalls += 1
        }, parentPID: { [self] raw in
            XCTAssertEqual(raw, handle); parentCalls += 1; return parent
        }, isCurrent: { [self] raw in
            XCTAssertEqual(raw, handle); currentCalls += 1; return !revoked
        })
    }
}

@MainActor final class NativeStoreHostIdentityTests: XCTestCase {
    func testPublicInitializerCannotCreateAuthorityFromAbsentOrForeignHandles() {
        XCTAssertThrowsError(try NativeStoreHostLease(nativeLease: nil))
        XCTAssertThrowsError(try NativeStoreHostLease(nativeLease: OpaquePointer(bitPattern: 0x4141)))
    }

    func testFailedRetainDoesNotInspectOrReleaseAnUnownedHandle() {
        let probe = StoreHostLeaseProbe(); probe.permitsRetain = false
        XCTAssertThrowsError(try NativeStoreHostLease(nativeLease: probe.handle, operations: probe.operations))
        XCTAssertEqual(probe.retainCalls, 1)
        XCTAssertEqual(probe.parentCalls, 0)
        XCTAssertEqual(probe.currentCalls, 0)
        XCTAssertEqual(probe.releaseCalls, 0)
    }

    func testInvalidNativeParentMetadataReleasesTheRetainedHandle() {
        for parent in [Int32(-1), 0, 1] {
            let probe = StoreHostLeaseProbe(); probe.parent = parent
            XCTAssertThrowsError(try NativeStoreHostLease(nativeLease: probe.handle, operations: probe.operations))
            XCTAssertEqual(probe.retainCalls, 1)
            XCTAssertEqual(probe.parentCalls, 1)
            XCTAssertEqual(probe.currentCalls, 0)
            XCTAssertEqual(probe.releaseCalls, 1)
        }
    }

    func testStaleNativeLeaseIsRejectedAndReleasedDuringConstruction() {
        let probe = StoreHostLeaseProbe(); probe.revoked = true
        XCTAssertThrowsError(try NativeStoreHostLease(nativeLease: probe.handle, operations: probe.operations))
        XCTAssertEqual(probe.retainCalls, 1)
        XCTAssertEqual(probe.parentCalls, 1)
        XCTAssertEqual(probe.currentCalls, 1)
        XCTAssertEqual(probe.releaseCalls, 1)
    }

    func testIdentityRetainsLeaseAndEveryValidityCheckObservesRevocation() throws {
        let probe = StoreHostLeaseProbe()
        var lease: NativeStoreHostLease? = try NativeStoreHostLease(nativeLease: probe.handle, operations: probe.operations)
        var identity: NativeStoreHostIdentity? = try NativeStoreHostIdentity(lease: XCTUnwrap(lease))
        XCTAssertEqual(identity?.process, 4242)
        XCTAssertEqual(probe.retainCalls, 1)
        lease = nil
        XCTAssertEqual(probe.releaseCalls, 0)
        let before = probe.currentCalls
        XCTAssertTrue(try XCTUnwrap(identity).isValid)
        XCTAssertTrue(try XCTUnwrap(identity).isValid)
        XCTAssertEqual(probe.currentCalls, before + 2)
        probe.revoked = true
        XCTAssertFalse(try XCTUnwrap(identity).isValid)
        XCTAssertEqual(probe.currentCalls, before + 3)
        identity = nil
        XCTAssertEqual(probe.releaseCalls, 1)
    }

    func testRevocationBetweenSnapshotAndIdentityConstructionFailsClosed() throws {
        let probe = StoreHostLeaseProbe()
        var lease: NativeStoreHostLease? = try NativeStoreHostLease(nativeLease: probe.handle, operations: probe.operations)
        probe.revoked = true
        XCTAssertThrowsError(try NativeStoreHostIdentity(lease: XCTUnwrap(lease)))
        XCTAssertEqual(probe.retainCalls, 1)
        XCTAssertEqual(probe.releaseCalls, 0)
        lease = nil
        XCTAssertEqual(probe.releaseCalls, 1)
    }

    func testParentMetadataCannotChangeWhileCurrentnessStaysTrue() throws {
        let probe = StoreHostLeaseProbe()
        let lease = try NativeStoreHostLease(nativeLease: probe.handle, operations: probe.operations)
        let identity = try NativeStoreHostIdentity(lease: lease)
        probe.parent = 5252
        XCTAssertFalse(identity.isValid)
        XCTAssertEqual(identity.process, 4242)
        XCTAssertFalse(lease.isCurrent)
    }
}
#endif
