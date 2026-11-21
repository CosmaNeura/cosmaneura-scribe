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
    private let opaqueDigest = String(repeating: "ab", count: 32)

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

    func testDeleteARemovesOwnedAndUnownedResidueLeavesB() throws {
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
        // Simulate pre-upgrade unowned residue: create under A then strip ownedDigests.
        try harness.store.setActiveWriteAccount(accountA)
        try harness.store.create(key: "legacy-unkeyed-record", data: Data([8]))
        try harness.store.create(
            key: "scribe-native-binding:v1:\(opaqueDigest)",
            data: Data([9])
        )
        try harness.stripOwnedDigests()

        try harness.store.claimLegacyAccount(accountA) // no-op
        XCTAssertEqual(try harness.store.wipeAccount(accountA), 0)
        let remaining = try harness.store.list()
        XCTAssertEqual(remaining, [
            "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
        ])
    }

    func testBsDeleteLeavesAsOwnedOpaqueDigest() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.setActiveWriteAccount(accountA)
        let opaque = "scribe-native-binding:v1:\(String(repeating: "cd", count: 32))"
        try harness.store.create(key: opaque, data: Data([4]))
        try harness.store.create(
            key: "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
            data: Data([5])
        )

        XCTAssertEqual(try harness.store.wipeAccount(accountB), 0)
        XCTAssertEqual(try harness.store.list(), [opaque])
        XCTAssertEqual(try harness.store.get(key: opaque).data, Data([4]))
    }

    func testFailedOpaqueWriteLeavesNoRecord() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        // No active write owner → opaque create refuses; no .sq left behind.
        XCTAssertThrowsError(
            try harness.store.create(
                key: "scribe-native-lease:v1:\(String(repeating: "ef", count: 32))",
                data: Data([1])
            )
        ) { error in
            XCTAssertEqual(error as? SecureQueueError, .invalidArgument)
        }
        XCTAssertEqual(try harness.store.list(), [])
        let sqFiles = try FileManager.default.contentsOfDirectory(at: harness.directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "sq" }
        XCTAssertEqual(sqFiles, [])
    }

    func testSwitchingAccountsWithoutRememberRefusesOpaqueWrite() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.setActiveWriteAccount(accountA)
        try harness.store.setActiveWriteAccount(nil) // sign-out / switch without remember
        XCTAssertThrowsError(
            try harness.store.create(
                key: "scribe-native-passage:v1:\(String(repeating: "11", count: 32)):seg",
                data: Data([2])
            )
        ) { error in
            XCTAssertEqual(error as? SecureQueueError, .invalidArgument)
        }
    }

    func testPostUpgradeOpaqueWriteRequiresOwnerAndWipesWithAccount() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.rememberAccount(accountId: accountA, accountIdentitySHA256: identityA)
        let opaque = "scribe-native-binding:v1:\(String(repeating: "22", count: 32))"
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

    func testInterruptedMigrationNeverDropsRecords() throws {
        let harness = try Harness()
        defer { harness.tearDown() }

        try harness.store.setActiveWriteAccount(accountA)
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
        XCTAssertEqual(try harness.store.list().count, 1)
    }

    func testV2IndexMissingOwnedDigestsIsCorrupt() throws {
        let payload: [String: Any] = [
            "v": 2,
            "migrated": true,
            "rememberedScopes": [identityA: accountA],
            "activeWriteAccountId": NSNull(),
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        XCTAssertThrowsError(try SecureQueueAccountIndex.decode(data)) { error in
            XCTAssertEqual(error as? SecureQueueError, .corrupt)
        }
    }

    func testV2IndexRejectsNonHexDigest() throws {
        let payload: [String: Any] = [
            "v": 2,
            "migrated": true,
            "ownedDigests": ["not-64-hex": accountA],
            "rememberedScopes": [:] as [String: String],
            "activeWriteAccountId": NSNull(),
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        XCTAssertThrowsError(try SecureQueueAccountIndex.decode(data)) { error in
            XCTAssertEqual(error as? SecureQueueError, .corrupt)
        }
    }

    func testDecodesRound1IndexWithoutInferringActiveWriteOwner() throws {
        let payload: [String: Any] = [
            "v": 1,
            "migrated": true,
            "legacyDigests": [String(repeating: "ab", count: 32)],
            "claimedLegacy": [accountA: [String(repeating: "ab", count: 32)]],
            "rememberedAccountId": accountA,
            "rememberedAccountIdentitySHA256": identityA,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        let index = try SecureQueueAccountIndex.decode(data)
        XCTAssertTrue(index.migrated)
        XCTAssertEqual(index.rememberedScopes[identityA], accountA)
        XCTAssertNil(index.activeWriteAccountId) // never inferred from single scope
        XCTAssertEqual(index.ownedDigests, [:])
    }

    func testPendingWipeRetryOnFreshStoreInstance() throws {
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
        // Leave a pending wipe as if a prior attempt crashed mid-wipe.
        let pending = harness.directory.appendingPathComponent(SecureQueueAccountIndex.pendingWipeFileName)
        let pendingPayload = try JSONSerialization.data(
            withJSONObject: ["v": 1, "accountId": accountA],
            options: [.sortedKeys]
        )
        try pendingPayload.write(to: pending, options: [.atomic])

        let relaunched = try SecureQueueStore(
            directoryURL: harness.directory,
            keychainService: harness.service,
            keychainAccount: harness.account
        )
        XCTAssertEqual(try relaunched.completePendingOrClearAll(), 0)
        XCTAssertEqual(try relaunched.list(), [
            "scribe-provider-queue:v1:\(accountB):\(workspace):\(session):b",
        ])
    }

    func testClearAllIgnoringPendingWipeDoesNotHonorPendingFile() throws {
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
        let pending = harness.directory.appendingPathComponent(SecureQueueAccountIndex.pendingWipeFileName)
        try JSONSerialization.data(withJSONObject: ["v": 1, "accountId": accountA])
            .write(to: pending, options: [.atomic])

        // v1 marker path: ignore pending → wipe everything.
        XCTAssertEqual(try harness.store.clearAllIgnoringPendingWipe(), 2)
        XCTAssertEqual(try harness.store.list(), [])
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

        func stripOwnedDigests() throws {
            let url = directory.appendingPathComponent(SecureQueueAccountIndex.fileName)
            var index = try SecureQueueAccountIndex.decode(Data(contentsOf: url))
            index.ownedDigests = [:]
            try index.encode().write(to: url, options: [.atomic])
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
