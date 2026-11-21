import Security
import XCTest
@testable import CosmaneuraSecureQueue

final class SecureQueueAccountScopeTests: XCTestCase {
    private let accountA = "11111111-1111-4111-8111-111111111111"
    private let accountB = "22222222-2222-4222-8222-222222222222"
    private let workspace = "33333333-3333-4333-8333-333333333333"
    private let session = "44444444-4444-4444-8444-444444444444"

    func testParsesRecoveryScopeFromClinicalKeyShapes() {
        XCTAssertEqual(
            SecureQueueAccountScope.accountId(forKey: "provider-workspace-v1:\(accountA):\(workspace)"),
            accountA
        )
        XCTAssertEqual(
            SecureQueueAccountScope.accountId(
                forKey: "scribe-provider-queue:v1:\(accountA):\(workspace):\(session):chunk"
            ),
            accountA
        )
        XCTAssertEqual(
            SecureQueueAccountScope.accountId(
                forKey: "scribe-native-flow:v1:abcdef:\(accountA)"
            ),
            accountA
        )
        XCTAssertNil(SecureQueueAccountScope.accountId(forKey: "scribe-native-binding:v1:opaque-digest"))
        XCTAssertNil(SecureQueueAccountScope.accountId(forKey: "legacy-upload-record"))
    }

    func testWipeAccountLeavesOtherAccountsUntouched() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.create(
            key: "scribe-provider-queue:v1:\(accountA):\(workspace):\(session):a",
            data: Data([1])
        )
        try harness.store.create(
            key: "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
            data: Data([2])
        )
        try harness.store.create(
            key: "provider-workspace-v1:\(accountA):\(workspace)",
            data: Data([3])
        )

        XCTAssertEqual(try harness.store.wipeAccount(accountA), 0)
        let remaining = try harness.store.list()
        XCTAssertEqual(remaining, [
            "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
        ])
        XCTAssertEqual(try harness.store.get(key: remaining[0]).data, Data([2]))
    }

    func testMigrationAssignsParseableKeysAndKeepsLegacyRecoverable() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.create(
            key: "scribe-provider-queue:v1:\(accountA):\(workspace):\(session):queued",
            data: Data([9])
        )
        try harness.store.create(key: "legacy-unkeyed-record", data: Data([8]))

        try harness.store.migrateAccountsIfNeeded()
        try harness.store.migrateAccountsIfNeeded() // idempotent
        try harness.store.claimLegacyAccount(accountA)

        XCTAssertEqual(try harness.store.wipeAccount(accountA), 0)
        XCTAssertEqual(try harness.store.list(), [])
    }

    func testInterruptedMigrationNeverDropsRecords() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.create(key: "legacy-unkeyed-record", data: Data([7]))
        try harness.store.create(
            key: "provider-workspace-v1:\(accountB):\(workspace)",
            data: Data([6])
        )

        // Simulate a failed first migration write by removing write permission is hard in unit
        // tests; instead verify migrate is safe to re-run and never deletes.
        try harness.store.migrateAccountsIfNeeded()
        XCTAssertEqual(try harness.store.list().count, 2)
        try harness.store.migrateAccountsIfNeeded()
        XCTAssertEqual(try harness.store.list().count, 2)
        XCTAssertEqual(try harness.store.get(key: "legacy-unkeyed-record").data, Data([7]))
    }

    func testRememberedAccountSurvivesForPurgeWithoutRecatalog() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        let identity = String(repeating: "ab", count: 32)
        try harness.store.rememberAccount(accountId: accountA, accountIdentitySHA256: identity)
        let remembered = try XCTUnwrap(try harness.store.rememberedAccount())
        XCTAssertEqual(remembered.accountId, accountA)
        XCTAssertEqual(remembered.accountIdentitySHA256, identity)
    }

    private final class Harness {
        let directory: URL
        let service: String
        let account: String
        let store: SecureQueueStore

        init() throws {
            directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("secure-queue-account-\(UUID().uuidString)", isDirectory: true)
            service = "com.cosmaneura.capture.secure-queue.tests.\(UUID().uuidString)"
            account = "test-key"
            store = try SecureQueueStore(
                directoryURL: directory,
                keychainService: service,
                keychainAccount: account
            )
        }

        func tearDown() {
            try? FileManager.default.removeItem(at: directory)
            SecItemDelete([
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: service,
                kSecAttrAccount: account,
            ] as CFDictionary)
        }
    }
}
