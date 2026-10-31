import Foundation
import XCTest
@testable import ClerkKit

/// Pure configuration and in-memory recovery only. No Clerk.configure, SDK auth,
/// SecItem call, token, account, real journal or cached credential is involved.
@MainActor final class ProductionStorageNamespaceTests: XCTestCase {
    let bundle = "com.cosmasos.synthetic.desktop.auth.storage"
    var service: String { bundle + ".clerk" }
    let stageKey = "pk_test_" + Data("storage-stage.clerk.accounts.dev$".utf8).base64EncodedString()
    let productionKey = "pk_live_" + Data("storage-production.example.test$".utf8).base64EncodedString()

    private func configuration(_ key: String, production: Bool = false) throws -> ConfigurationManager {
        let config = ConfigurationManager()
        try config.configure(publishableKey: key, options: .init(
            logLevel: .error, telemetryEnabled: false,
            keychainConfig: .init(service: service, accessGroup: "SYNTHETIC." + bundle),
            redirectConfig: .init(redirectUrl: bundle + "://callback", callbackUrlScheme: bundle),
            watchConnectivityEnabled: false, sharedSessionSync: nil,
            authStorageNamespace: production ? .productionInstanceV1 : nil
        ))
        return config
    }

    private func owner(_ config: ConfigurationManager) -> String {
        DependencyContainer.authStorageOwnerIdentifier(
            ownerIdentifier: bundle, options: config.options,
            frontendApiUrl: config.frontendApiUrl, publishableKey: config.publishableKey
        )!
    }

    private func intent(_ config: ConfigurationManager) -> SharedSessionOwnerSlotClearRecovery.Intent {
        let namespace = SharedSessionNamespace(frontendApiUrl: config.frontendApiUrl, publishableKey: config.publishableKey)
        return .init(
            localIdentityService: DependencyContainer.stableIdentityService(
                configuredService: config.options.keychainConfig.service,
                instanceFingerprint: namespace.fingerprint, ownerIdentifier: owner(config)
            ),
            slotService: SharedSessionOwnerSlotStore.service(
                configuredService: config.options.keychainConfig.service, instanceFingerprint: namespace.fingerprint
            ),
            slotAccessGroup: "SYNTHETIC." + bundle,
            slotAccount: SharedSessionOwnerSlotStore.account(instanceFingerprint: namespace.fingerprint, ownerIdentifier: owner(config)),
            instanceFingerprint: namespace.fingerprint, ownerIdentifier: owner(config)
        )
    }

    private func journalService(_ config: ConfigurationManager) throws -> String {
        // Inspect the SDK's constructed query namespace, not its live Keychain.
        // No method of this SystemKeychain instance is called.
        let context = try XCTUnwrap(SharedSessionOwnerSlotClearRecovery.liveContext(
            ownerIdentifier: owner(config), currentIntent: nil
        ))
        return try XCTUnwrap(Mirror(reflecting: context.journal).children.first { $0.label == "service" }?.value as? String)
    }

    func testProductionCacheOwnerAndJournalAreIsolatedWhileLegacyNamesStayExact() throws {
        let stage = try configuration(stageKey)
        let legacyProduction = try configuration(productionKey)
        let production = try configuration(productionKey, production: true)
        XCTAssertEqual(stage.options.keychainConfig.service, service)
        XCTAssertEqual(legacyProduction.options.keychainConfig.service, service)
        XCTAssertEqual(owner(stage), bundle)
        XCTAssertEqual(owner(legacyProduction), bundle)
        XCTAssertEqual(try journalService(stage), bundle + ".clerk.shared-session-clear-recovery.v1")
        XCTAssertEqual(try journalService(legacyProduction), try journalService(stage))
        XCTAssertNotEqual(production.options.keychainConfig.service, stage.options.keychainConfig.service)
        XCTAssertNotEqual(owner(production), owner(stage))
        XCTAssertNotEqual(try journalService(production), try journalService(stage))
        XCTAssertNotEqual(intent(production).localIdentityService, intent(stage).localIdentityService)
        XCTAssertNotEqual(intent(production).slotService, intent(stage).slotService)
        XCTAssertEqual(production.options.keychainConfig.accessGroup, stage.options.keychainConfig.accessGroup)
        XCTAssertEqual(production.options.redirectConfig.redirectUrl, stage.options.redirectConfig.redirectUrl)
        XCTAssertEqual(production.options.redirectConfig.callbackUrlScheme, bundle)
        XCTAssertNil(production.options.sharedSessionSync)
        let stores = MemoryNamespaces()
        stores.keychain(stage.options.keychainConfig.service).set(Data([19]), forKey: "synthetic-cache-marker")
        XCTAssertTrue(stores.keychain(legacyProduction.options.keychainConfig.service).hasItem(forKey: "synthetic-cache-marker"))
        XCTAssertFalse(stores.keychain(production.options.keychainConfig.service).hasItem(forKey: "synthetic-cache-marker"))
    }

    func testProductionRecoveryPreservesPendingStageStateAndBothScopesRecoverNormally() throws {
        let stage = try configuration(stageKey)
        let production = try configuration(productionKey, production: true)
        let stageIntent = intent(stage), productionIntent = intent(production)
        let stores = MemoryNamespaces()
        let stageJournal = stores.keychain(try journalService(stage))
        let productionJournal = stores.keychain(try journalService(production))
        let targets = MemoryRecoveryTargets(stores: stores)
        let stageIdentity = try targets.localIdentityStore(for: stageIntent)
        let productionIdentity = try targets.localIdentityStore(for: productionIntent)
        let emptyIdentity = SharedSessionLocalIdentity(state: .cleared, deviceToken: nil, client: nil, serverDate: nil)
        try stageIdentity.save(emptyIdentity)
        try productionIdentity.save(emptyIdentity)
        let stageContext = SharedSessionOwnerSlotClearRecovery.Context(journal: stageJournal, currentIntent: stageIntent, targetProvider: targets)
        let productionContext = SharedSessionOwnerSlotClearRecovery.Context(journal: productionJournal, currentIntent: productionIntent, targetProvider: targets)
        try SharedSessionOwnerSlotClearRecovery.markPending(in: stageContext)
        try SharedSessionOwnerSlotClearRecovery.markPending(in: productionContext)
        let stageJournalBefore = stageJournal.data(forKey: SharedSessionOwnerSlotClearRecovery.storageKey)
        XCTAssertTrue(try SharedSessionOwnerSlotClearRecovery.recoverIfNeeded(in: productionContext))
        XCTAssertEqual(stageJournal.data(forKey: SharedSessionOwnerSlotClearRecovery.storageKey), stageJournalBefore)
        XCTAssertNotNil(try stageIdentity.loadRecord())
        XCTAssertEqual(targets.slots(stageIntent).deletes, 0)
        XCTAssertNil(try productionIdentity.loadRecord())
        XCTAssertFalse(productionJournal.hasItem(forKey: SharedSessionOwnerSlotClearRecovery.storageKey))
        XCTAssertEqual(targets.slots(productionIntent).deletes, 1)
        XCTAssertTrue(try SharedSessionOwnerSlotClearRecovery.recoverIfNeeded(in: stageContext))
        XCTAssertNil(try stageIdentity.loadRecord())
        XCTAssertEqual(targets.slots(stageIntent).deletes, 1)
        XCTAssertFalse(try SharedSessionOwnerSlotClearRecovery.recoverIfNeeded(in: productionContext))
    }

    func testProductionStorageOptInRejectsDevelopmentKey() {
        XCTAssertThrowsError(try configuration(stageKey, production: true))
    }
}

private final class MemoryNamespaces: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: MemoryKeychain] = [:]
    func keychain(_ service: String) -> MemoryKeychain {
        lock.withLock {
            if let existing = values[service] { return existing }
            let storage = MemoryKeychain(); values[service] = storage; return storage
        }
    }
}

private final class MemorySlots: SharedSessionSlotStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var deletes: Int { lock.withLock { count } }
    func loadOwnSlot() -> SharedSessionOwnerSlot? { nil }
    func loadAllSlots() -> [SharedSessionOwnerSlot] { [] }
    func saveOwnSlot(_: SharedSessionOwnerSlot) {}
    func deleteOwnSlot() { lock.withLock { count += 1 } }
}

private final class MemoryRecoveryTargets: SharedSessionClearRecoveryTargets, @unchecked Sendable {
    let stores: MemoryNamespaces
    private let lock = NSLock()
    private var slotStores: [String: MemorySlots] = [:]
    init(stores: MemoryNamespaces) { self.stores = stores }
    func localIdentityStore(for intent: SharedSessionOwnerSlotClearRecovery.Intent) throws -> any SharedSessionLocalIdentityStoring {
        SharedSessionLocalIdentityStore(keychain: stores.keychain(intent.localIdentityService))
    }
    func slots(_ intent: SharedSessionOwnerSlotClearRecovery.Intent) -> MemorySlots {
        lock.withLock {
            let key = intent.slotService + "." + intent.slotAccount
            if let existing = slotStores[key] { return existing }
            let store = MemorySlots(); slotStores[key] = store; return store
        }
    }
    func slotStore(for intent: SharedSessionOwnerSlotClearRecovery.Intent) throws -> any SharedSessionSlotStoring { slots(intent) }
}
