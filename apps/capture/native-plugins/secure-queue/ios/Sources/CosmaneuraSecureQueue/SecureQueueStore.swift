import CryptoKit
import Foundation
import Security

final class SecureQueueStore {
    // All in-process clients share the same lock, including native recording.
    static let shared = Result { try SecureQueueStore() }
    private static let keyBytes = 32
    private static let envelopeMagic = Data([0x43, 0x53, 0x51, 0x31]) // CSQ1
    private static let keychainService = "com.cosmaneura.capture.secure-queue"
    private static let keychainAccount = "queue-storage-key-v1"

    let directoryURL: URL
    private let service: String
    private let account: String
    private let fileManager: FileManager
    private let operationLock = NSLock()

    convenience init() throws {
        let fileManager = FileManager.default
        guard let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw SecureQueueError.io
        }
        try self.init(
            directoryURL: applicationSupport
                .appendingPathComponent("CosmaneuraSecureQueue", isDirectory: true)
                .appendingPathComponent("v1", isDirectory: true),
            keychainService: Self.keychainService,
            keychainAccount: Self.keychainAccount,
            fileManager: fileManager
        )
    }

    init(
        directoryURL: URL,
        keychainService: String,
        keychainAccount: String,
        fileManager: FileManager = .default
    ) throws {
        self.directoryURL = directoryURL
        self.service = keychainService
        self.account = keychainAccount
        self.fileManager = fileManager
        try ensureDirectory()
    }

    @discardableResult
    func put(key: String, data: Data) throws -> UInt64 {
        operationLock.lock()
        defer { operationLock.unlock() }
        let digest = try SecureQueueRecordCodec.digest(for: key)
        try ensureDirectory()
        let target = try recordURL(for: digest)
        let storageKey: SymmetricKey
        let revision: UInt64
        if fileManager.fileExists(atPath: target.path) {
            storageKey = try loadStorageKey(allowCreate: false)
            let current = try readRecord(at: target, digest: digest, storageKey: storageKey)
            guard current.key == key else {
                throw SecureQueueError.corrupt
            }
            revision = try nextRevision(after: current.revision)
        } else {
            let hasRecords = try hasCommittedRecords()
            storageKey = try loadStorageKey(allowCreate: !hasRecords)
            revision = 1
        }
        try writeRecord(
            key: key,
            data: data,
            revision: revision,
            digest: digest,
            storageKey: storageKey
        )
        return revision
    }

    /// Checks the existing queue volume without loading or creating a storage key.
    func availableBytes() throws -> Int {
        operationLock.lock()
        defer { operationLock.unlock() }
        let values = try directoryURL.resourceValues(forKeys: [.volumeAvailableCapacityKey])
        guard let bytes = values.volumeAvailableCapacity, bytes >= 0 else {
            throw SecureQueueError.io
        }
        return bytes
    }

    func create(key: String, data: Data) throws -> UInt64 {
        operationLock.lock()
        defer { operationLock.unlock() }
        let digest = try SecureQueueRecordCodec.digest(for: key)
        try ensureDirectory()
        let target = try recordURL(for: digest)
        guard !fileManager.fileExists(atPath: target.path) else {
            throw SecureQueueError.alreadyExists
        }
        let hasRecords = try hasCommittedRecords()
        let storageKey = try loadStorageKey(allowCreate: !hasRecords)
        try writeRecord(
            key: key,
            data: data,
            revision: 1,
            digest: digest,
            storageKey: storageKey
        )
        return 1
    }

    func compareAndSwap(
        key: String,
        expectedRevision: UInt64,
        data: Data
    ) throws -> UInt64 {
        operationLock.lock()
        defer { operationLock.unlock() }
        guard expectedRevision > 0, expectedRevision <= SecureQueueRecordCodec.maximumRevision else {
            throw SecureQueueError.invalidArgument
        }
        let digest = try SecureQueueRecordCodec.digest(for: key)
        let target = try recordURL(for: digest)
        guard fileManager.fileExists(atPath: target.path) else {
            throw SecureQueueError.notFound
        }
        let storageKey = try loadStorageKey(allowCreate: false)
        let current = try readRecord(at: target, digest: digest, storageKey: storageKey)
        guard current.key == key else {
            throw SecureQueueError.corrupt
        }
        guard current.revision == expectedRevision else {
            throw SecureQueueError.revisionConflict
        }
        let revision = try nextRevision(after: current.revision)
        try writeRecord(
            key: key,
            data: data,
            revision: revision,
            digest: digest,
            storageKey: storageKey
        )
        return revision
    }

    func get(key: String) throws -> SecureQueueRecord {
        operationLock.lock()
        defer { operationLock.unlock() }
        let digest = try SecureQueueRecordCodec.digest(for: key)
        let target = try recordURL(for: digest)
        guard fileManager.fileExists(atPath: target.path) else {
            throw SecureQueueError.notFound
        }
        let storageKey = try loadStorageKey(allowCreate: false)
        let record = try readRecord(at: target, digest: digest, storageKey: storageKey)
        guard record.key == key else {
            throw SecureQueueError.corrupt
        }
        return record
    }

    func list() throws -> [String] {
        operationLock.lock()
        defer { operationLock.unlock() }
        return try listKeysLocked()
    }

    func delete(key: String) throws -> Bool {
        operationLock.lock()
        defer { operationLock.unlock() }
        let digest = try SecureQueueRecordCodec.digest(for: key)
        let target = try recordURL(for: digest)
        guard fileManager.fileExists(atPath: target.path) else {
            return false
        }
        do {
            try fileManager.removeItem(at: target)
            return true
        } catch {
            throw SecureQueueError.io
        }
    }

    func clear(forRenderer: Bool = false) throws -> Int {
        operationLock.lock()
        defer { operationLock.unlock() }
        return try clearLocked(forRenderer: forRenderer)
    }

    /// Idempotent migration of the pre-account (unkeyed) queue. Never deletes records on failure.
    func migrateAccountsIfNeeded() throws {
        operationLock.lock()
        defer { operationLock.unlock() }
        try migrateAccountsIfNeededLocked()
    }

    /// Attribute legacy (unparseable) digests to the signed-in account. Idempotent; never drops data.
    func claimLegacyAccount(_ accountId: String) throws {
        operationLock.lock()
        defer { operationLock.unlock() }
        guard let account = SecureQueueAccountScope.normalizedAccountId(accountId) else {
            throw SecureQueueError.invalidArgument
        }
        try migrateAccountsIfNeededLocked()
        var index = try loadAccountIndex()
        if !index.legacyDigests.isEmpty {
            var claimed = index.claimedLegacy[account] ?? []
            claimed.formUnion(index.legacyDigests)
            index.claimedLegacy[account] = claimed
            index.legacyDigests = []
            try writeAccountIndex(index)
        }
    }

    /// Remember the active recoveryScope for a later account purge (and optional identity binding).
    func rememberAccount(accountId: String, accountIdentitySHA256: String?) throws {
        operationLock.lock()
        defer { operationLock.unlock() }
        guard let account = SecureQueueAccountScope.normalizedAccountId(accountId) else {
            throw SecureQueueError.invalidArgument
        }
        if let identity = accountIdentitySHA256 {
            guard identity.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
                throw SecureQueueError.invalidArgument
            }
        }
        try migrateAccountsIfNeededLocked()
        var index = try loadAccountIndex()
        index.rememberedAccountId = account
        index.rememberedAccountIdentitySHA256 = accountIdentitySHA256
        if !index.legacyDigests.isEmpty {
            var claimed = index.claimedLegacy[account] ?? []
            claimed.formUnion(index.legacyDigests)
            index.claimedLegacy[account] = claimed
            index.legacyDigests = []
        }
        try writeAccountIndex(index)
    }

    func rememberedAccount() throws -> (accountId: String, accountIdentitySHA256: String?)? {
        operationLock.lock()
        defer { operationLock.unlock() }
        let index = (try? loadAccountIndex()) ?? .empty
        guard let accountId = index.rememberedAccountId else { return nil }
        return (accountId, index.rememberedAccountIdentitySHA256)
    }

    /// Delete every record owned by `accountId` (key-scoped or claimed legacy). Returns remaining
    /// count for that account after the wipe (0 = empty). Other accounts are untouched.
    func wipeAccount(_ accountId: String) throws -> Int {
        operationLock.lock()
        defer { operationLock.unlock() }
        return try wipeAccountLocked(accountId)
    }

    /// Launch/retry helper: prefer pending/remembered per-account wipe; otherwise full clear
    /// (legacy confirmed markers from before per-account SecureQueue).
    func completePendingOrClearAll() throws -> Int {
        operationLock.lock()
        defer { operationLock.unlock() }
        if let pending = try readPendingWipeAccount() {
            return try wipeAccountLocked(pending)
        }
        let remembered = (try? loadAccountIndex())?.rememberedAccountId
        if let remembered {
            return try wipeAccountLocked(remembered)
        }
        return try clearLocked(forRenderer: false)
    }

    private func clearLocked(forRenderer: Bool) throws -> Int {
        try ensureDirectory()
        let urls: [URL]
        do {
            urls = try fileManager.contentsOfDirectory(
                at: directoryURL,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: []
            )
        } catch {
            throw SecureQueueError.io
        }
        if forRenderer {
            // Hold the same lock as native creation and inspect before removing
            // anything. A list-then-clear in the plugin would race native custody.
            let committed = urls.filter { $0.pathExtension == "sq" }
            if !committed.isEmpty {
                let storageKey = try loadStorageKey(allowCreate: false)
                for url in committed {
                    let digest = try SecureQueueRecordCodec.digest(fromFilename: url.lastPathComponent)
                    let record = try readRecord(at: url, digest: digest, storageKey: storageKey)
                    guard SecureQueueRecordCodec.isRendererKey(record.key) else {
                        throw SecureQueueError.invalidArgument
                    }
                }
            }
        }
        var removedRecords = 0
        for url in urls {
            let name = url.lastPathComponent
            if name == SecureQueueAccountIndex.fileName || name == SecureQueueAccountIndex.pendingWipeFileName {
                if forRenderer { continue }
            }
            let isCommittedRecord = url.pathExtension == "sq"
            do {
                try fileManager.removeItem(at: url)
            } catch {
                throw SecureQueueError.io
            }
            if isCommittedRecord {
                removedRecords += 1
            }
        }
        if !forRenderer {
            try? writeAccountIndex(.empty)
            try? clearPendingWipeAccount()
        }
        return removedRecords
    }

    private func wipeAccountLocked(_ accountId: String) throws -> Int {
        guard let account = SecureQueueAccountScope.normalizedAccountId(accountId) else {
            throw SecureQueueError.invalidArgument
        }
        try migrateAccountsIfNeededLocked()
        try writePendingWipeAccount(account)
        let owned = try keysOwnedByAccountLocked(account)
        for key in owned {
            let digest = try SecureQueueRecordCodec.digest(for: key)
            let target = try recordURL(for: digest)
            if fileManager.fileExists(atPath: target.path) {
                do { try fileManager.removeItem(at: target) } catch { throw SecureQueueError.io }
            }
        }
        var index = try loadAccountIndex()
        index.claimedLegacy[account] = nil
        if index.rememberedAccountId == account {
            index.rememberedAccountId = nil
            index.rememberedAccountIdentitySHA256 = nil
        }
        try writeAccountIndex(index)
        let remaining = try keysOwnedByAccountLocked(account).count
        if remaining == 0 {
            try clearPendingWipeAccount()
        }
        return remaining
    }

    private func migrateAccountsIfNeededLocked() throws {
        var index = (try? loadAccountIndex()) ?? .empty
        if index.migrated { return }
        // Failure must not delete records or mark migration complete.
        let keys: [String]
        do {
            keys = try listKeysLocked()
        } catch {
            return
        }
        var legacy = Set<String>()
        for key in keys {
            if SecureQueueAccountScope.accountId(forKey: key) != nil { continue }
            do {
                let digest = try SecureQueueRecordCodec.digest(for: key)
                legacy.insert(digest.map { String(format: "%02x", $0) }.joined())
            } catch {
                return
            }
        }
        index.legacyDigests = legacy
        index.migrated = true
        do {
            try writeAccountIndex(index)
        } catch {
            // Leave migrated=false so a later launch retries; records remain.
            return
        }
    }

    private func keysOwnedByAccountLocked(_ account: String) throws -> [String] {
        let keys = try listKeysLocked()
        let index = (try? loadAccountIndex()) ?? .empty
        let claimedHex = index.claimedLegacy[account] ?? []
        var owned: [String] = []
        for key in keys {
            if SecureQueueAccountScope.belongs(key: key, toAccount: account) {
                owned.append(key)
                continue
            }
            if SecureQueueAccountScope.accountId(forKey: key) == nil {
                let digest = try SecureQueueRecordCodec.digest(for: key)
                let hex = digest.map { String(format: "%02x", $0) }.joined()
                if claimedHex.contains(hex) { owned.append(key) }
            }
        }
        return owned
    }

    private func listKeysLocked() throws -> [String] {
        try ensureDirectory()
        let urls: [URL]
        do {
            urls = try fileManager.contentsOfDirectory(
                at: directoryURL,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            )
        } catch {
            throw SecureQueueError.io
        }
        let recordURLs = urls
            .filter { $0.pathExtension == "sq" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard !recordURLs.isEmpty else { return [] }
        let storageKey = try loadStorageKey(allowCreate: false)
        var keys = [String]()
        keys.reserveCapacity(recordURLs.count)
        for url in recordURLs {
            let digest = try SecureQueueRecordCodec.digest(fromFilename: url.lastPathComponent)
            let record = try readRecord(at: url, digest: digest, storageKey: storageKey)
            let actualDigest = try SecureQueueRecordCodec.digest(for: record.key)
            guard actualDigest == digest else { throw SecureQueueError.corrupt }
            keys.append(record.key)
        }
        return keys.sorted()
    }

    private func accountIndexURL() -> URL {
        directoryURL.appendingPathComponent(SecureQueueAccountIndex.fileName, isDirectory: false)
    }

    private func pendingWipeURL() -> URL {
        directoryURL.appendingPathComponent(SecureQueueAccountIndex.pendingWipeFileName, isDirectory: false)
    }

    private func loadAccountIndex() throws -> SecureQueueAccountIndex {
        let url = accountIndexURL()
        guard fileManager.fileExists(atPath: url.path) else { return .empty }
        do {
            let data = try Data(contentsOf: url)
            return try SecureQueueAccountIndex.decode(data)
        } catch let error as SecureQueueError {
            throw error
        } catch {
            throw SecureQueueError.io
        }
    }

    private func writeAccountIndex(_ index: SecureQueueAccountIndex) throws {
        try ensureDirectory()
        let data: Data
        do { data = try index.encode() } catch { throw SecureQueueError.io }
        do {
            try data.write(to: accountIndexURL(), options: [.atomic])
        } catch {
            throw SecureQueueError.io
        }
    }

    private func writePendingWipeAccount(_ accountId: String) throws {
        try ensureDirectory()
        let data: Data
        do {
            data = try JSONSerialization.data(
                withJSONObject: ["v": 1, "accountId": accountId],
                options: [.sortedKeys]
            )
        } catch {
            throw SecureQueueError.io
        }
        do {
            try data.write(to: pendingWipeURL(), options: [.atomic])
        } catch {
            throw SecureQueueError.io
        }
    }

    private func readPendingWipeAccount() throws -> String? {
        let url = pendingWipeURL()
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        do {
            let data = try Data(contentsOf: url)
            guard
                let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let accountId = object["accountId"] as? String
            else {
                return nil
            }
            return SecureQueueAccountScope.normalizedAccountId(accountId)
        } catch {
            return nil
        }
    }

    private func clearPendingWipeAccount() throws {
        let url = pendingWipeURL()
        guard fileManager.fileExists(atPath: url.path) else { return }
        do { try fileManager.removeItem(at: url) } catch { throw SecureQueueError.io }
    }

    private func open(
        envelope: Data,
        digest: Data,
        storageKey: SymmetricKey
    ) throws -> SecureQueueRecord {
        guard
            envelope.count > Self.envelopeMagic.count,
            envelope.prefix(Self.envelopeMagic.count) == Self.envelopeMagic
        else {
            throw SecureQueueError.corrupt
        }
        let sealedBox: AES.GCM.SealedBox
        do {
            sealedBox = try AES.GCM.SealedBox(
                combined: Data(envelope.dropFirst(Self.envelopeMagic.count))
            )
        } catch {
            throw SecureQueueError.corrupt
        }
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(
                sealedBox,
                using: storageKey,
                authenticating: Self.envelopeMagic + digest
            )
        } catch {
            throw SecureQueueError.corrupt
        }
        return try SecureQueueRecordCodec.decode(plaintext)
    }

    private func readRecord(
        at url: URL,
        digest: Data,
        storageKey: SymmetricKey
    ) throws -> SecureQueueRecord {
        let envelope: Data
        do {
            envelope = try Data(contentsOf: url, options: [.mappedIfSafe])
        } catch {
            throw SecureQueueError.io
        }
        return try open(envelope: envelope, digest: digest, storageKey: storageKey)
    }

    private func writeRecord(
        key: String,
        data: Data,
        revision: UInt64,
        digest: Data,
        storageKey: SymmetricKey
    ) throws {
        let plaintext = try SecureQueueRecordCodec.encode(
            key: key,
            data: data,
            revision: revision
        )
        let sealed: AES.GCM.SealedBox
        do {
            sealed = try AES.GCM.seal(
                plaintext,
                using: storageKey,
                authenticating: Self.envelopeMagic + digest
            )
        } catch {
            throw SecureQueueError.keyUnavailable
        }
        guard let combined = sealed.combined else {
            throw SecureQueueError.keyUnavailable
        }
        var envelope = Self.envelopeMagic
        envelope.append(combined)
        try ensureDirectory()
        do {
            try envelope.write(
                to: try recordURL(for: digest),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        } catch let error as SecureQueueError {
            throw error
        } catch {
            throw SecureQueueError.io
        }
    }

    private func nextRevision(after revision: UInt64) throws -> UInt64 {
        guard revision < SecureQueueRecordCodec.maximumRevision else {
            throw SecureQueueError.revisionConflict
        }
        return revision + 1
    }

    private func hasCommittedRecords() throws -> Bool {
        let urls: [URL]
        do {
            urls = try fileManager.contentsOfDirectory(
                at: directoryURL,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )
        } catch {
            throw SecureQueueError.io
        }
        return urls.contains { $0.pathExtension == "sq" }
    }

    private func recordURL(for digest: Data) throws -> URL {
        directoryURL.appendingPathComponent(
            try SecureQueueRecordCodec.filename(for: digest),
            isDirectory: false
        )
    }

    private func ensureDirectory() throws {
        do {
            try fileManager.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true,
                attributes: [
                    .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
                ]
            )
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: directoryURL.path
            )
            var resourceValues = URLResourceValues()
            resourceValues.isExcludedFromBackup = true
            var mutableDirectoryURL = directoryURL
            try mutableDirectoryURL.setResourceValues(resourceValues)
        } catch {
            throw SecureQueueError.io
        }
    }

    private func loadStorageKey(allowCreate: Bool) throws -> SymmetricKey {
        let stored = copyStoredKey()
        if stored.status == errSecSuccess, let data = stored.data {
            guard data.count == Self.keyBytes else {
                throw SecureQueueError.keyUnavailable
            }
            return SymmetricKey(data: data)
        }
        guard stored.status == errSecItemNotFound, allowCreate else {
            throw SecureQueueError.keyUnavailable
        }

        var generated = Data(count: Self.keyBytes)
        let randomStatus = generated.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress else {
                return errSecParam
            }
            return SecRandomCopyBytes(kSecRandomDefault, bytes.count, baseAddress)
        }
        guard randomStatus == errSecSuccess else {
            throw SecureQueueError.keyUnavailable
        }

        var addQuery = baseKeychainQuery()
        addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        addQuery[kSecValueData] = generated
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecDuplicateItem {
            let duplicate = copyStoredKey()
            guard
                duplicate.status == errSecSuccess,
                let existing = duplicate.data,
                existing.count == Self.keyBytes
            else {
                throw SecureQueueError.keyUnavailable
            }
            return SymmetricKey(data: existing)
        }
        guard addStatus == errSecSuccess else {
            throw SecureQueueError.keyUnavailable
        }
        return SymmetricKey(data: generated)
    }

    private func copyStoredKey() -> (status: OSStatus, data: Data?) {
        var query = baseKeychainQuery()
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return (status, item as? Data)
    }

    private func baseKeychainQuery() -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
    }
}
