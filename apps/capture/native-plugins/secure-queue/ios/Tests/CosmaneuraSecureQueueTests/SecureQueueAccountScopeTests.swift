import Security
import XCTest
@testable import CosmaneuraSecureQueue

final class SecureQueueAccountScopeTests: XCTestCase {
    private let accountA = "11111111-1111-4111-8111-111111111111"
    private let accountB = "22222222-2222-4222-8222-222222222222"
    private let workspace = "33333333-3333-4333-8333-333333333333"
    private let session = "44444444-4444-4444-8444-444444444444"
    private let identityA = String(repeating: "aa", count: 32)
    private let identityB = String(repeating: "bb", count: 32)

    func testParsesRecoveryScopeFromClinicalKeyShapes() throws {
        // #file → .../secure-queue/ios/Tests/CosmaneuraSecureQueueTests/*.swift
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // CosmaneuraSecureQueueTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // secure-queue
            .appendingPathComponent("fixtures/clinical-key-shapes.json")
        let data = try Data(contentsOf: fixtureURL)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let shapes = try XCTUnwrap(json["shapes"] as? [[String: Any]])
        for shape in shapes {
            let key = try XCTUnwrap(shape["key"] as? String)
            let owner = shape["owner"] as? String
            XCTAssertEqual(SecureQueueAccountScope.accountId(forKey: key), owner?.lowercased(), key)
        }
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

    func testDeleteARemovesOwnedAndLegacyResidueLeavesB() throws {
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
        try harness.store.create(key: "legacy-unkeyed-record", data: Data([8]))
        try harness.store.create(
            key: "scribe-native-binding:v1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            data: Data([9])
        )

        try harness.store.migrateAccountsIfNeeded()
        // H4: claim is a no-op; legacy stays unowned until residue wipe.
        try harness.store.claimLegacyAccount(accountA)

        XCTAssertEqual(try harness.store.wipeAccount(accountA), 0)
        let remaining = try harness.store.list()
        XCTAssertEqual(remaining, [
            "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
        ])
    }

    func testPostUpgradeOpaqueWriteRequiresOwnerAndWipesWithAccount() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.migrateAccountsIfNeeded()
        try harness.store.rememberAccount(accountId: accountA, accountIdentitySHA256: identityA)

        let opaque = "scribe-native-binding:v1:feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface"
        try harness.store.create(key: opaque, data: Data([4]))
        try harness.store.create(
            key: "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
            data: Data([5])
        )

        XCTAssertEqual(try harness.store.wipeAccount(accountA), 0)
        XCTAssertEqual(try harness.store.list(), [
            "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
        ])
    }

    func testOpaqueWriteWithoutRememberFailsClosedAfterMigration() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.migrateAccountsIfNeeded()
        XCTAssertThrowsError(
            try harness.store.create(
                key: "scribe-native-lease:v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                data: Data([1])
            )
        ) { error in
            XCTAssertEqual(error as? SecureQueueError, .invalidArgument)
        }
    }

    func testInterruptedMigrationNeverDropsRecords() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.create(key: "legacy-unkeyed-record", data: Data([7]))
        try harness.store.create(
            key: "provider-workspace-v1:\(accountB):\(workspace)",
            data: Data([6])
        )

        try harness.store.migrateAccountsIfNeeded()
        XCTAssertEqual(try harness.store.list().count, 2)
        try harness.store.migrateAccountsIfNeeded()
        XCTAssertEqual(try harness.store.list().count, 2)
        XCTAssertEqual(try harness.store.get(key: "legacy-unkeyed-record").data, Data([7]))
    }

    func testRememberedAccountRequiresExactIdentity() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.rememberAccount(accountId: accountA, accountIdentitySHA256: identityA)
        let remembered = try XCTUnwrap(
            try harness.store.rememberedAccount(accountIdentitySHA256: identityA)
        )
        XCTAssertEqual(remembered.accountId, accountA)
        XCTAssertEqual(remembered.accountIdentitySHA256, identityA)

        XCTAssertNil(try harness.store.rememberedAccount(accountIdentitySHA256: nil))
        XCTAssertNil(try harness.store.rememberedAccount(accountIdentitySHA256: identityB))
        XCTAssertThrowsError(
            try harness.store.rememberAccount(accountId: accountA, accountIdentitySHA256: nil)
        )
    }

    func testCorruptIndexFailsClosedAndNeverRebuildsClaims() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.create(
            key: "provider-workspace-v1:\(accountA):\(workspace)",
            data: Data([1])
        )
        let indexURL = harness.directory.appendingPathComponent(SecureQueueAccountIndex.fileName)
        try Data("{not-json".utf8).write(to: indexURL)

        XCTAssertThrowsError(try harness.store.migrateAccountsIfNeeded()) { error in
            XCTAssertEqual(error as? SecureQueueError, .corrupt)
        }
        XCTAssertThrowsError(try harness.store.wipeAccount(accountA)) { error in
            XCTAssertEqual(error as? SecureQueueError, .corrupt)
        }
        // Records must still be present — fail closed does not rebuild or delete via claims.
        XCTAssertEqual(try harness.store.list().count, 1)
    }

    func testWipeDeletesUnreadableRecordAndContinues() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.create(
            key: "scribe-provider-queue:v1:\(accountA):\(workspace):\(session):good",
            data: Data([1])
        )
        try harness.store.create(
            key: "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):keep",
            data: Data([2])
        )

        // Plant a corrupt .sq sibling; wipe must delete it and still finish.
        let digest = try SecureQueueRecordCodec.digest(for: "corrupt-planted")
        let badURL = harness.directory.appendingPathComponent(
            try SecureQueueRecordCodec.filename(for: digest)
        )
        try Data([0x00, 0x01, 0x02]).write(to: badURL)

        XCTAssertEqual(try harness.store.wipeAccount(accountA), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: badURL.path))
        XCTAssertEqual(try harness.store.list(), [
            "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):keep",
        ])
    }

    func testBCannotInheritAsLegacyViaClaimNoOp() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.create(key: "legacy-unkeyed-record", data: Data([3]))
        try harness.store.migrateAccountsIfNeeded()
        try harness.store.claimLegacyAccount(accountB)
        // Residue still unowned; wiping A (not B) removes it.
        XCTAssertEqual(try harness.store.wipeAccount(accountA), 0)
        XCTAssertEqual(try harness.store.list(), [])
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
