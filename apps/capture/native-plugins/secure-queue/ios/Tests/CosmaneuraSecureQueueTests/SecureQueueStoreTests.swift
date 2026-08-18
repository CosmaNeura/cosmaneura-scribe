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
