#if os(macOS)
import Foundation

/// Native ownership survives a missing prepare reply. Main-process correlation
/// IDs are not server proofs or capture authority and are never persisted.
@MainActor final class DesktopSourceRegistry {
    private final class Entry {
        let preparationID: UUID
        let preparation: NativeSourcePreparation
        let owner: NativeSourceStartOwner
        var grant: NativeSourceGrant?
        var authorizationRequested = false
        var retiring = false

        init(_ id: UUID, _ preparation: NativeSourcePreparation, _ owner: NativeSourceStartOwner) {
            preparationID = id; self.preparation = preparation; self.owner = owner
        }
    }
    private var entries: [UUID: Entry] = [:]
    private var retiredPreparations: Set<UUID> = []
    private var retiredSources: Set<String> = []
    private var closed = false

    func prepare(id: UUID, preparation: NativeSourcePreparation,
                 makeOwner: () throws -> NativeSourceStartOwner) async throws -> NativeSourceGrant {
        guard !closed, !retiredPreparations.contains(id),
              !entries.values.contains(where: { $0.retiring }) else { throw ProviderNativeError.unavailable }
        let entry: Entry
        if let prior = entries[preparation.sessionID] {
            guard prior.preparationID == id, prior.preparation == preparation, !prior.retiring else {
                throw ProviderNativeError.unavailable
            }
            entry = prior
        } else {
            guard entries.count < 8, !entries.values.contains(where: { $0.preparationID == id }) else {
                throw ProviderNativeError.unavailable
            }
            entry = Entry(id, preparation, try makeOwner())
            entries[preparation.sessionID] = entry
        }
        let grant = try await entry.owner.prepare()
        guard !closed, entries[preparation.sessionID] === entry, !entry.retiring else {
            throw ProviderNativeError.unavailable
        }
        entry.grant = grant
        return grant
    }

    func authorize(sourceLeaseID: String) async throws -> NativeSourceDecision {
        guard !closed, let entry = find(sourceLeaseID), !entry.retiring else {
            throw ProviderNativeError.unavailable
        }
        // Set before the await: a lost authorization reply is still a possible
        // issued start and cannot be retired by preparation-only cleanup.
        entry.authorizationRequested = true
        let decision = try await entry.owner.authorize()
        guard !closed, entries[entry.preparation.sessionID] === entry, !entry.retiring else {
            throw ProviderNativeError.unavailable
        }
        return decision
    }

    func releasePreparation(id: UUID) async throws {
        guard !closed else { throw ProviderNativeError.unavailable }
        if retiredPreparations.contains(id) { return }
        guard let entry = entries.values.first(where: { $0.preparationID == id }) else {
            // Cancellation can precede native dispatch. Remember this ID for
            // this registry's lifetime so a late prepare cannot create an owner.
            retiredPreparations.insert(id)
            return
        }
        guard !entry.authorizationRequested else { throw ProviderNativeError.unavailable }
        entry.retiring = true
        // No authorization was ever requested for this owner, hence no physical
        // source could start. The existing stop route also handles expired leases.
        // A pending prepare or lost retirement reply retains the exact owner.
        try await entry.owner.cancelUnstartedDesktopPreparation()
        retire(entry)
    }

    func release(sourceLeaseID: String, stopped: Bool) async throws {
        guard !closed else { throw ProviderNativeError.unavailable }
        guard let entry = find(sourceLeaseID) else {
            if retiredSources.contains(sourceLeaseID) { return }
            throw ProviderNativeError.invalidRequest
        }
        entry.retiring = true
        if stopped { try await entry.owner.confirmStopped() }
        else {
            // A known preparation can also outlive authentication. Its stop-only
            // cleanup is safe only if no authorization was ever requested.
            guard !entry.authorizationRequested else { throw ProviderNativeError.unavailable }
            try await entry.owner.cancelUnstartedDesktopPreparation()
        }
        retire(entry)
    }

    func close() {
        closed = true
        for entry in entries.values { entry.owner.close() }
        entries.removeAll()
    }

    /// Authentication loss fences every pending/future start. Keep the original
    /// volatile proof and correlation solely for same-account cessation retry.
    func retireForAuthenticationChange() {
        for entry in entries.values {
            entry.retiring = true
            entry.owner.retireForAuthenticationChange()
        }
    }

    private func find(_ sourceLeaseID: String) -> Entry? {
        entries.values.first(where: { $0.grant?.sourceLeaseID == sourceLeaseID })
    }
    private func retire(_ entry: Entry) {
        entries.removeValue(forKey: entry.preparation.sessionID)
        retiredPreparations.insert(entry.preparationID)
        if let grant = entry.grant { retiredSources.insert(grant.sourceLeaseID) }
    }
}
#endif
