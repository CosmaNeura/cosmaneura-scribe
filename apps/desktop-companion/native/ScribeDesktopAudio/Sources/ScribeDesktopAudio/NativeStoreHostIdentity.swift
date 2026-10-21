#if SCRIBE_MAC_APP_STORE_XPC
import Foundation
@preconcurrency import ScribeStorePipe

/// Internal injection is limited to wrapper tests. Production callers can only
/// retain a listener-created handle through the fixed native operations.
struct NativeStoreHostLeaseOperations: @unchecked Sendable {
    let retain: (OpaquePointer?) -> OpaquePointer?
    let release: (OpaquePointer) -> Void
    let parentPID: (OpaquePointer) -> Int32
    let isCurrent: (OpaquePointer) -> Bool

    static let native = Self(
        retain: { scribe_store_host_retain($0) },
        release: { scribe_store_host_release($0) },
        parentPID: { scribe_store_host_parent_pid($0) },
        isCurrent: { scribe_store_host_is_current($0) }
    )
}

/// Retained before an asynchronous hop. The native registry rejects foreign or
/// released handles; a PID or presentation message cannot create this lease.
public final class NativeStoreHostLease: @unchecked Sendable {
    public let parentProcess: Int32
    private let native: OpaquePointer
    private let operations: NativeStoreHostLeaseOperations

    public convenience init(nativeLease: OpaquePointer?) throws {
        try self.init(nativeLease: nativeLease, operations: .native)
    }

    init(nativeLease: OpaquePointer?, operations: NativeStoreHostLeaseOperations) throws {
        guard let retained = operations.retain(nativeLease) else {
            throw ProviderPresentationFailure.unavailable
        }
        let process = operations.parentPID(retained)
        guard process > 1, operations.isCurrent(retained) else {
            operations.release(retained)
            throw ProviderPresentationFailure.unavailable
        }
        self.native = retained; self.operations = operations; self.parentProcess = process
    }

    public var isCurrent: Bool {
        operations.isCurrent(native) && operations.parentPID(native) == parentProcess
    }

    deinit { operations.release(native) }
}

/// Window-owner PID is metadata from the authenticated broker lease. Every
/// validity check asks the native broker; Swift does not recreate PID authority.
@MainActor public final class NativeStoreHostIdentity {
    let process: Int32
    private let lease: NativeStoreHostLease

    public init(lease: NativeStoreHostLease) throws {
        guard lease.isCurrent else {
            throw ProviderPresentationFailure.unavailable
        }
        self.process = lease.parentProcess; self.lease = lease
    }

    var isValid: Bool { lease.isCurrent }
}
#endif
