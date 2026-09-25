// INERT PROPOSAL. No selected binary imports this file. The live Keychain
// implementation must not be invoked before exact storage/signing approval.
import Foundation
import Security
import CosmasNativeAuth

enum NativeSourceJournalError: Error { case unavailable }

enum NativeSourceJournalPlatform: String, Codable, Sendable {
    case desktop, ios
    var bundleID: String {
        self == .desktop ? "com.cosmaneura.scribe.beta.desktop.auth" : "com.cosmaneura.scribe.beta"
    }
    var source: NativeSourcePreparation.Source { self == .desktop ? .desktop : .ios }
}

/// Native-private recovery metadata. The only recovered operation is stop.
/// No SDK token, audio, transcript, note or upload URL belongs in this record.
struct NativeSourceProofRecord: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    let attemptID: UUID
    let stopKey: UUID
    let ownerProof: String
    let userID: String
    let organizationID: String?
    let workspaceID: UUID
    let bindingRef: String
    let sessionID: UUID
    let source: String
    let leaseID: UUID
    let leaseReceiptID: UUID
    let leaseGeneration: Int
    let captureAuthorizedUntil: String
    let firstSequenceNumber: Int

    var description: String { "NativeSourceProofRecord(<protected>)" }
    var debugDescription: String { description }

    init(attemptID: UUID, stopKey: UUID, proof: String, identity: NativeAuthIdentity,
         preparation: NativeSourcePreparation) {
        self.attemptID = attemptID; self.stopKey = stopKey; ownerProof = proof
        userID = identity.userID; organizationID = identity.organizationID
        workspaceID = preparation.workspaceID; bindingRef = preparation.bindingRef
        sessionID = preparation.sessionID; source = preparation.source.rawValue
        leaseID = preparation.leaseID; leaseReceiptID = preparation.leaseReceiptID
        leaseGeneration = preparation.leaseGeneration
        captureAuthorizedUntil = preparation.captureAuthorizedUntil
        firstSequenceNumber = preparation.firstSequenceNumber
    }

    func validate(platform: NativeSourceJournalPlatform) throws {
        let idPattern = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
        guard ownerProof.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              userID.range(of: idPattern, options: .regularExpression) != nil,
              organizationID == nil || organizationID?.range(of: idPattern, options: .regularExpression) != nil,
              bindingRef.range(of: "^scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil,
              source == platform.source.rawValue, leaseGeneration > 0, leaseGeneration < 2_147_483_648,
              (0..<2048).contains(firstSequenceNumber), captureAuthorizedUntil.utf8.count <= 64,
              nativeRecoveryDate(captureAuthorizedUntil) != nil else {
            throw NativeSourceJournalError.unavailable
        }
        // Expired deadlines remain valid for cessation, never for a new start.
    }
}

/// Implementations must use one exact app-private record, never a wildcard
/// credential query. Journal mutation is serialized by MainActor and the native
/// process coordinator; it is not exposed through renderer or Capacitor IPC.
@MainActor protocol NativeSourceJournalBacking {
    func read() throws -> Data?
    func write(_ value: Data) throws
}

@MainActor final class NativeSourceProofJournal {
    private struct Envelope: Codable {
        let schema: Int
        let platform: NativeSourceJournalPlatform
        var anchor: NativeFenceAnchor?
        var owners: [NativeSourceProofRecord]
    }
    private let platform: NativeSourceJournalPlatform
    private let backing: any NativeSourceJournalBacking
    private var value: Envelope
    private var poisoned = false
    private static let maximumBytes = 65_536

    init(platform: NativeSourceJournalPlatform, backing: any NativeSourceJournalBacking) throws {
        self.platform = platform; self.backing = backing
        value = try Self.decode(backing.read(), platform: platform)
    }

    var anchor: NativeFenceAnchor? { value.anchor }
    var pending: [NativeSourceProofRecord] { value.owners }

    func requireUsable() throws {
        guard !poisoned else { throw NativeSourceJournalError.unavailable }
    }

    /// Call again after acquiring coordinator exclusivity. The first read may
    /// have raced an old coordinator which was still finishing a journal write.
    func reloadWhileExclusive(expectedAnchor: NativeFenceAnchor?) throws {
        let fresh = try Self.decode(backing.read(), platform: platform)
        guard fresh.anchor == expectedAnchor else { throw NativeSourceJournalError.unavailable }
        value = fresh; poisoned = false
    }

    func initializeAnchor(_ anchor: NativeFenceAnchor) throws {
        guard !poisoned, platform == .desktop else { throw NativeSourceJournalError.unavailable }
        if let prior = value.anchor {
            guard prior == anchor else { throw NativeSourceJournalError.unavailable }
            return
        }
        guard value.owners.isEmpty else { throw NativeSourceJournalError.unavailable }
        var next = value; next.anchor = anchor
        try commit(next)
    }

    func insertBeforeDispatch(_ record: NativeSourceProofRecord) throws {
        guard !poisoned, platform == .ios || value.anchor != nil else { throw NativeSourceJournalError.unavailable }
        try record.validate(platform: platform)
        if let existing = value.owners.first(where: { $0.attemptID == record.attemptID }) {
            guard existing == record else { throw NativeSourceJournalError.unavailable }
            return
        }
        guard value.owners.count < 8,
              !value.owners.contains(where: { $0.sessionID == record.sessionID || $0.stopKey == record.stopKey }) else {
            throw NativeSourceJournalError.unavailable
        }
        var next = value; next.owners.append(record)
        try commit(next)
    }

    /// Only the native owner calls this after checking an authenticated terminal
    /// receipt and physical cessation. A failed write retains/poisons custody;
    /// it is never converted into permission to open another recorder.
    func removeAfterConfirmedStop(_ record: NativeSourceProofRecord) throws {
        guard !poisoned else { throw NativeSourceJournalError.unavailable }
        guard let index = value.owners.firstIndex(where: { $0.attemptID == record.attemptID }),
              value.owners[index] == record else { throw NativeSourceJournalError.unavailable }
        var next = value; next.owners.remove(at: index)
        try commit(next) // Keep the permanent anchor even when there are no owners.
    }

    private func commit(_ next: Envelope) throws {
        do {
            let bytes = try JSONEncoder().encode(next)
            guard bytes.count <= Self.maximumBytes else { throw NativeSourceJournalError.unavailable }
            try backing.write(bytes)
            value = next
        } catch {
            // A storage error can be ambiguous. Only a new exclusive recovery
            // read may establish the committed state; do not assume rollback.
            poisoned = true
            throw NativeSourceJournalError.unavailable
        }
    }

    private static func decode(_ bytes: Data?, platform: NativeSourceJournalPlatform) throws -> Envelope {
        guard let bytes else { return Envelope(schema: 1, platform: platform, anchor: nil, owners: []) }
        guard bytes.count <= maximumBytes,
              let value = try? JSONDecoder().decode(Envelope.self, from: bytes),
              value.schema == 1, value.platform == platform, value.owners.count <= 8,
              Set(value.owners.map(\.attemptID)).count == value.owners.count,
              Set(value.owners.map(\.sessionID)).count == value.owners.count,
              Set(value.owners.map(\.stopKey)).count == value.owners.count,
              platform == .desktop || value.anchor == nil,
              platform == .ios || value.owners.isEmpty || value.anchor != nil else {
            throw NativeSourceJournalError.unavailable
        }
        for record in value.owners { try record.validate(platform: platform) }
        return value
    }
}

/// One exact new Keychain namespace with explicit app access group and no sync.
/// Installed policy/signing acceptance is separate from compiling this adapter.
@MainActor final class KeychainNativeSourceJournal: NativeSourceJournalBacking {
    struct Calls {
        let copy: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
        let add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
        let update: (CFDictionary, CFDictionary) -> OSStatus
        static var live: Calls { .init(copy: SecItemCopyMatching, add: SecItemAdd, update: SecItemUpdate) }
    }
    private let query: [CFString: Any]
    private let calls: Calls

    init(platform: NativeSourceJournalPlatform, bundleIdentifier: String, calls: Calls = .live) throws {
        guard bundleIdentifier == platform.bundleID else { throw NativeSourceJournalError.unavailable }
        self.calls = calls
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: bundleIdentifier + ".source-owner",
            kSecAttrAccount: "journal-v1",
            kSecAttrAccessGroup: "JVV65668U6." + bundleIdentifier,
            kSecAttrSynchronizable: false,
            // Still supported by SecItem; this adapter never permits an implicit
            // authentication UI while an owner is being persisted or retired.
            kSecUseAuthenticationUI: kSecUseAuthenticationUIFail,
        ]
#if os(macOS)
        query[kSecUseDataProtectionKeychain] = true
#endif
        self.query = query
    }

    func read() throws -> Data? {
        var request = query
        request[kSecReturnData] = true; request[kSecReturnAttributes] = true
        request[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = calls.copy(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let value = result as? [CFString: Any],
              let bytes = value[kSecValueData] as? Data,
              value[kSecAttrAccessible] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
              value[kSecAttrService] as? String == query[kSecAttrService] as? String,
              value[kSecAttrAccount] as? String == "journal-v1",
              value[kSecAttrAccessGroup] as? String == query[kSecAttrAccessGroup] as? String,
              value[kSecAttrSynchronizable] as? Bool != true else { throw NativeSourceJournalError.unavailable }
        return bytes
    }

    func write(_ value: Data) throws {
        guard value.count <= 65_536 else { throw NativeSourceJournalError.unavailable }
        _ = try read() // Refuse an existing item with a different protection policy.
        var item = query
        item[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        item[kSecValueData] = value
        let inserted = calls.add(item as CFDictionary, nil)
        if inserted == errSecSuccess { return }
        guard inserted == errSecDuplicateItem,
              calls.update(query as CFDictionary, [kSecValueData: value] as CFDictionary) == errSecSuccess else {
            throw NativeSourceJournalError.unavailable
        }
    }
}

func nativeRecoveryDate(_ value: String) -> Date? {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let result = format.date(from: value) { return result }
    format.formatOptions = [.withInternetDateTime]
    return format.date(from: value)
}
