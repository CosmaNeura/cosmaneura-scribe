import Security
import XCTest
@testable import CosmaneuraSecureQueue

final class SecureQueueStoreTests: XCTestCase {
    private var directory: URL!
    private var service: String!
    private var account: String!
    private var store: SecureQueueStore!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("secure-queue-tests-\(UUID().uuidString)", isDirectory: true)
        service = "com.cosmaneura.capture.secure-queue.tests.\(UUID().uuidString)"
        account = "test-key"
        store = try SecureQueueStore(
            directoryURL: directory,
            keychainService: service,
            keychainAccount: account
        )
    }

    override func tearDownWithError() throws {
        if let directory {
            try? FileManager.default.removeItem(at: directory)
        }
        if let service, let account {
            SecItemDelete([
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: service,
                kSecAttrAccount: account,
            ] as CFDictionary)
        }
        store = nil
        directory = nil
        service = nil
        account = nil
    }

    func testRoundTripReplacementListingAndPurge() throws {
        XCTAssertEqual(try store.create(key: "record-b", data: Data([0x01, 0x02])), 1)
        XCTAssertEqual(try store.put(key: "record-a", data: Data([0x03])), 1)
        XCTAssertEqual(try store.list(), ["record-a", "record-b"])
        XCTAssertEqual(try store.get(key: "record-b").data, Data([0x01, 0x02]))

        XCTAssertThrowsError(try store.create(key: "record-b", data: Data([0x04]))) { error in
            XCTAssertEqual(error as? SecureQueueError, .alreadyExists)
        }
        XCTAssertThrowsError(
            try store.compareAndSwap(key: "record-b", expectedRevision: 9, data: Data([0x04]))
        ) { error in
            XCTAssertEqual(error as? SecureQueueError, .revisionConflict)
        }
        XCTAssertEqual(
            try store.compareAndSwap(
                key: "record-b",
                expectedRevision: 1,
                data: Data([0x04])
            ),
            2
        )
        XCTAssertEqual(try store.get(key: "record-b").data, Data([0x04]))
        XCTAssertEqual(try store.get(key: "record-b").revision, 2)
        XCTAssertTrue(try store.delete(key: "record-a"))
        XCTAssertFalse(try store.delete(key: "record-a"))
        XCTAssertEqual(try store.clear(), 1)
        XCTAssertEqual(try store.list(), [])
    }

    func testStorageCapacityDoesNotCreateKeysOrChangeRetainedRecords() throws {
        XCTAssertGreaterThan(try store.availableBytes(), 0)
        XCTAssertEqual(try store.list(), [])
        let query = [kSecClass: kSecClassGenericPassword, kSecAttrService: service!,
                     kSecAttrAccount: account!] as [CFString: Any]
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, nil), errSecItemNotFound)
        try store.create(key: "retained", data: Data([1, 2, 3]))
        XCTAssertGreaterThan(try store.availableBytes(), 0)
        XCTAssertEqual(try store.get(key: "retained").data, Data([1, 2, 3]))
        XCTAssertEqual(try store.get(key: "retained").revision, 1)
    }

    func testRendererClearPreservesNativeCustodyAndAllAudio() throws {
        try store.create(key: "legacy-upload-record", data: Data([1, 2]))
        XCTAssertEqual(try store.clear(forRenderer: true), 1)
        let native = "scribe-native-flow:v1:synthetic"
        try store.create(key: native, data: Data([3, 4]))
        try store.create(key: "scribe-provider-queue:v1:synthetic", data: Data([5, 6]))
        XCTAssertThrowsError(try store.clear(forRenderer: true)) { error in
            XCTAssertEqual(error as? SecureQueueError, .invalidArgument)
        }
        XCTAssertEqual(try store.get(key: native).data, Data([3, 4]))
        XCTAssertEqual(try store.get(key: "scribe-provider-queue:v1:synthetic").data, Data([5, 6]))
        for name in ["flow", "binding", "lease", "reservations", "future-private"] {
            XCTAssertFalse(SecureQueueRecordCodec.isRendererKey("scribe-native-\(name):v1:synthetic"))
        }
        XCTAssertTrue(SecureQueueRecordCodec.isRendererKey("scribe-provider-queue:v1:synthetic"))
        XCTAssertTrue(SecureQueueRecordCodec.isRendererKey("creator-review-v1:synthetic"))
    }

    func testRendererAdapterDeniesEveryPrivateJournalOperation() throws {
        let renderer = RendererSecureQueueStore(store: store)
        for kind in ["flow", "binding", "lease", "reservations"] {
            let key = "scribe-native-\(kind):v1:synthetic"
            try store.create(key: key, data: Data([9]))
            XCTAssertThrowsError(try renderer.get(key: key))
            XCTAssertThrowsError(try renderer.put(key: key, data: Data([1])))
            XCTAssertThrowsError(try renderer.create(key: key + "-new", data: Data([1])))
            XCTAssertThrowsError(try renderer.compareAndSwap(key: key, expectedRevision: 1, data: Data([1])))
            XCTAssertThrowsError(try renderer.delete(key: key))
            XCTAssertEqual(try store.get(key: key).data, Data([9]))
        }
        let upload = "scribe-provider-queue:v1:synthetic"
        XCTAssertEqual(try renderer.create(key: upload, data: Data([2])), 1)
        XCTAssertEqual(try renderer.compareAndSwap(key: upload, expectedRevision: 1, data: Data([3])), 2)
        XCTAssertEqual(try renderer.list(), [upload])
        XCTAssertThrowsError(try renderer.clear())
        XCTAssertEqual(try renderer.get(key: upload).data, Data([3]))
        XCTAssertTrue(try renderer.delete(key: upload))
        XCTAssertEqual(try store.list().count, 4)
    }

    func testCiphertextDoesNotContainKeyOrRecordBytesAndRejectsTampering() throws {
        let recordBytes = Data("opaque-test-record".utf8)
        try store.put(key: "opaque-test-key", data: recordBytes)
        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ).filter { $0.pathExtension == "sq" }
        XCTAssertEqual(files.count, 1)
        let file = try XCTUnwrap(files.first)
        var envelope = try Data(contentsOf: file)
        XCTAssertNil(envelope.range(of: Data("opaque-test-key".utf8)))
        XCTAssertNil(envelope.range(of: recordBytes))

        envelope[envelope.index(before: envelope.endIndex)] ^= 0x01
        try envelope.write(to: file, options: .atomic)
        XCTAssertThrowsError(try store.get(key: "opaque-test-key")) { error in
            XCTAssertEqual(error as? SecureQueueError, .corrupt)
        }
    }

    func testDirectoryIsBackupExcludedAndKeyIsThisDeviceOnly() throws {
        try store.put(key: "record", data: Data())
        let values = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)

        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service as Any,
            kSecAttrAccount: account as Any,
            kSecReturnAttributes: kCFBooleanTrue as Any,
            kSecMatchLimit: kSecMatchLimitOne,
        ] as CFDictionary, &item)
        XCTAssertEqual(status, errSecSuccess)
        let attributes = try XCTUnwrap(item as? [CFString: Any])
        XCTAssertEqual(
            attributes[kSecAttrAccessible] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
    }
}
