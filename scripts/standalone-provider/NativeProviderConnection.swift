import Foundation
import CoreFoundation
import OSLog
import CosmasNativeAuth
import CosmaneuraNativeRecording

enum ProviderNativeError: String, Error, Sendable {
    case unavailable = "provider_native_unavailable"
    case invalidRequest = "provider_native_request_invalid"
    case cancelled = "provider_native_cancelled"
    case response = "provider_native_response_invalid"
    case authorityChanged = "provider_native_authority_changed"
}

enum ProviderNativeAction: String, Sendable {
    case catalog, encounters, mount, recorder
    case recorderContext = "recorder-context"
    case noteOpening = "note-opening"
    case sourceStart = "source-start"
    case sourceStartReady = "source-start-ready"
    case admission = "capture-admissions", operation = "capture-operations", note = "capture-notes"

    var bodyLimit: Int {
        switch self {
        case .catalog: 2
        case .encounters: 16384
        case .mount: 256
        case .recorder, .recorderContext, .noteOpening: 1024
        case .sourceStart: 4096
        case .sourceStartReady: 8192
        case .admission: 2048
        case .operation: 4_194_304
        case .note: 262_144 + 8192
        }
    }
    var responseLimit: Int {
        switch self {
        case .catalog, .encounters: 1_048_576
        case .mount, .recorder, .recorderContext, .sourceStart: 8192
        case .sourceStartReady: 16_384
        case .operation, .noteOpening: 32 * 1024 * 1024 + 8192
        case .admission, .note: 8 * 1024 * 1024
        }
    }

    func acceptsResponseStatus(_ status: Int) -> Bool {
        [200, 401, 403, 409, 422, 503].contains(status)
            || (self == .sourceStartReady && status == 404)
    }
}

struct ProviderNativeRequest: Sendable {
    let id: UUID
    let revision: String
    let action: ProviderNativeAction
    let key: String
    let body: Data

    var openingNonce: UUID? {
        guard action == .mount,
              let value = try? JSONSerialization.jsonObject(with: body) as? [String: String],
              Set(value.keys) == ["workspace_id", "opening_nonce"],
              let text = value["opening_nonce"], let nonce = UUID(uuidString: text),
              nonce.uuidString.lowercased() == text else { return nil }
        return nonce
    }
    var responseLimit: Int {
        openingNonce == nil ? action.responseLimit : 32 * 1024 * 1024 + 16_384
    }

    init(id: String, revision: String, action: String, key: String, body: String) throws {
        guard let identifier = UUID(uuidString: id), identifier.uuidString.lowercased() == id,
              UUID(uuidString: revision)?.uuidString.lowercased() == revision,
              let operation = ProviderNativeAction(rawValue: action),
              operation != .sourceStart, operation != .sourceStartReady,
              key.range(of: "^[A-Za-z0-9._:-]{8,255}$", options: .regularExpression) != nil,
              body.utf8.count <= operation.bodyLimit, let data = body.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (operation != .encounters || data.count <= 4096 ||
                value["action"] as? String == "private_note_save" && Set(value.keys) ==
                  ["action", "appointment_ref", "text", "expected_version", "change_key", "request_nonce"])
        else { throw ProviderNativeError.invalidRequest }
        self.id = identifier; self.revision = revision; self.action = operation
        self.key = key; self.body = data
    }

    // Not reachable from the generic Capacitor/renderer string-action initializer.
    init(nativeStartID: UUID, revision: String, key: String, body: Data,
         combinedPreparation: Bool = false) throws {
        let action: ProviderNativeAction = combinedPreparation ? .sourceStartReady : .sourceStart
        guard UUID(uuidString: revision)?.uuidString.lowercased() == revision,
              key.range(of: "^[A-Za-z0-9._:-]{8,255}$", options: .regularExpression) != nil,
              body.count <= action.bodyLimit,
              (try? JSONSerialization.jsonObject(with: body)) is [String: Any]
        else { throw ProviderNativeError.invalidRequest }
        self.id = nativeStartID; self.revision = revision; self.action = action
        self.key = key; self.body = body
    }
}

/// Only our complete, bounded Server-Timing vocabulary can enter diagnostics.
/// Missing or malformed metadata is discarded without changing the response.
struct ProviderServerTiming: Sendable, Equatable {
    enum Phase: String, CaseIterable, Sendable {
        case registry, workload_token, core_exchange, core_mount, core_binding
        case core_operation, core_encounter_lookup, total
    }
    private let values: [Phase: Double]

    func milliseconds(_ phase: Phase) -> Double { values[phase]! }

    static func parse(_ fields: [String]) -> ProviderServerTiming? {
        guard fields.count == 1, let field = fields.first, field.utf8.count <= 512,
              field.unicodeScalars.allSatisfy({ (32...126).contains($0.value) }) else { return nil }
        let metrics = field.split(separator: ",", omittingEmptySubsequences: false)
        guard metrics.count == Phase.allCases.count else { return nil }
        var values: [Phase: Double] = [:]
        for metric in metrics {
            let parts = metric.trimmingCharacters(in: .whitespaces)
                .split(separator: ";", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0].hasPrefix("scribe_"),
                  let phase = Phase(rawValue: String(parts[0].dropFirst(7))), values[phase] == nil,
                  parts[1].hasPrefix("dur=") else { return nil }
            let decimal = String(parts[1].dropFirst(4))
            guard decimal.range(of: "^[0-9]{1,7}(?:\\.[0-9]{1,3})?$", options: .regularExpression) != nil,
                  let duration = Double(decimal), duration.isFinite, (0...3_600_000).contains(duration)
            else { return nil }
            values[phase] = duration
        }
        guard values.count == Phase.allCases.count else { return nil }
        return ProviderServerTiming(values: values)
    }

    static func from(_ response: HTTPURLResponse) -> ProviderServerTiming? {
        // Foundation may coalesce repeated header lines. Repeated metrics in a
        // combined value and multiple case variants are rejected by parse().
        let fields = response.allHeaderFields.filter {
            ($0.key as? String)?.lowercased() == "server-timing"
        }
        guard fields.count == 1, let value = fields.first?.value as? String else { return nil }
        return parse([value])
    }
}

/// Optional v1 Core snapshots for this provider request. Nested totals overlap;
/// response-start observations omit unfinished work and are never authority.
struct ProviderCoreTiming: Sendable, Equatable {
    enum Phase: String, CaseIterable, Sendable {
        case workflow_token, workflow_http, capture_transaction
    }
    struct Measurement: Sendable, Equatable {
        let milliseconds: Double
        let count: Int
        let failures: Int
    }
    let observations: Int, accepted: Int, missing: Int, invalid: Int
    private let values: [Phase: Measurement]

    func measurement(_ phase: Phase) -> Measurement { values[phase]! }

    static func parse(_ fields: [String]) -> ProviderCoreTiming? {
        guard fields.count == 1, let field = fields.first, field.utf8.count <= 1024,
              field.unicodeScalars.allSatisfy({ (32...126).contains($0.value) }) else { return nil }
        let base = ["v", "observations", "accepted", "missing", "invalid", "response_start_only", "nonadditive"]
        let allowed = Set(base + Phase.allCases.flatMap {
            ["\($0.rawValue)_ms", "\($0.rawValue)_count", "\($0.rawValue)_failures"]
        })
        let parts = field.split(separator: ";", omittingEmptySubsequences: false)
        guard parts.count == allowed.count else { return nil }
        var row: [String: String] = [:]
        for part in parts {
            let item = part.split(separator: "=", omittingEmptySubsequences: false)
            guard item.count == 2, allowed.contains(String(item[0])), row[String(item[0])] == nil
            else { return nil }
            row[String(item[0])] = String(item[1])
        }
        func count(_ key: String, _ maximum: Int) -> Int? {
            guard let raw = row[key],
                  raw.range(of: "^(?:0|[1-9][0-9]{0,5})$", options: .regularExpression) != nil,
                  let value = Int(raw), (0...maximum).contains(value) else { return nil }
            return value
        }
        guard row["v"] == "1", row["response_start_only"] == "1", row["nonadditive"] == "1",
              let observations = count("observations", 16), let accepted = count("accepted", 16),
              let missing = count("missing", 16), let invalid = count("invalid", 16),
              accepted > 0, accepted + missing + invalid == observations else { return nil }
        var values: [Phase: Measurement] = [:]
        for phase in Phase.allCases {
            guard let raw = row["\(phase.rawValue)_ms"],
                  raw.range(of: "^[0-9]{1,7}(?:\\.[0-9]{1,3})?$", options: .regularExpression) != nil,
                  let ms = Double(raw), ms.isFinite, (0...Double(accepted * 600_000)).contains(ms),
                  let observedCount = count("\(phase.rawValue)_count", accepted * 10_000),
                  let failures = count("\(phase.rawValue)_failures", observedCount) else { return nil }
            values[phase] = Measurement(milliseconds: ms, count: observedCount, failures: failures)
        }
        return ProviderCoreTiming(observations: observations, accepted: accepted,
                                  missing: missing, invalid: invalid, values: values)
    }

    static func from(_ response: HTTPURLResponse) -> ProviderCoreTiming? {
        let fields = response.allHeaderFields.filter {
            ($0.key as? String)?.lowercased() == "x-scribe-core-timing"
        }
        guard fields.count == 1, let value = fields.first?.value as? String else { return nil }
        return parse([value])
    }
}

struct ProviderNativeReply: Sendable {
    let status: Int
    let body: Data
    let serverTiming: ProviderServerTiming?
    let coreTiming: ProviderCoreTiming?

    init(status: Int, body: Data, serverTiming: ProviderServerTiming? = nil,
         coreTiming: ProviderCoreTiming? = nil) {
        self.status = status; self.body = body; self.serverTiming = serverTiming
        self.coreTiming = coreTiming
    }
}

/// Local performance data only. Never accept request/reply bytes, identifiers,
/// credentials, URLs or error descriptions in this diagnostic boundary.
struct ProviderNativeRequestTiming: Sendable {
    let action: ProviderNativeAction
    let tokenMilliseconds: Int
    let receiverMilliseconds: Int?
    let totalMilliseconds: Int
    let status: Int?
    let completed: Bool
    let serverTiming: ProviderServerTiming?
    var coreTiming: ProviderCoreTiming? = nil

    private static let logger = Logger(subsystem: "com.cosmaneura.scribe.performance", category: "provider")
    private static let signposter = OSSignposter(logger: logger)

    static func begin(_ phase: StaticString) -> OSSignpostIntervalState {
        signposter.beginInterval(phase, id: signposter.makeSignpostID())
    }

    static func end(_ phase: StaticString, _ interval: OSSignpostIntervalState) {
        signposter.endInterval(phase, interval)
    }

    func log() {
        #if os(iOS)
        ProviderNativeTimingJournal.shared.record(self)
        #endif
        Self.logger.info("provider_request action=\(action.rawValue, privacy: .public) token_ms=\(tokenMilliseconds) receiver_ms=\(receiverMilliseconds ?? -1) total_ms=\(totalMilliseconds) status=\(status ?? 0) completed=\(completed) server_registry_ms=\(serverTiming?.milliseconds(.registry) ?? -1) server_workload_token_ms=\(serverTiming?.milliseconds(.workload_token) ?? -1) server_core_exchange_ms=\(serverTiming?.milliseconds(.core_exchange) ?? -1) server_core_mount_ms=\(serverTiming?.milliseconds(.core_mount) ?? -1) server_core_binding_ms=\(serverTiming?.milliseconds(.core_binding) ?? -1) server_core_operation_ms=\(serverTiming?.milliseconds(.core_operation) ?? -1) server_core_encounter_lookup_ms=\(serverTiming?.milliseconds(.core_encounter_lookup) ?? -1) server_total_ms=\(serverTiming?.milliseconds(.total) ?? -1)")
        if let core = coreTiming {
            let token = core.measurement(.workflow_token), http = core.measurement(.workflow_http)
            let transaction = core.measurement(.capture_transaction)
            Self.logger.info("provider_core_timing action=\(action.rawValue, privacy: .public) request_total_ms=\(totalMilliseconds) observations=\(core.observations) accepted=\(core.accepted) missing=\(core.missing) invalid=\(core.invalid) response_start_only=true nonadditive=true workflow_token_ms=\(token.milliseconds) workflow_token_count=\(token.count) workflow_token_failures=\(token.failures) workflow_http_ms=\(http.milliseconds) workflow_http_count=\(http.count) workflow_http_failures=\(http.failures) capture_transaction_ms=\(transaction.milliseconds) capture_transaction_count=\(transaction.count) capture_transaction_failures=\(transaction.failures)")
        }
    }

    static func milliseconds(from start: ContinuousClock.Instant, to end: ContinuousClock.Instant) -> Int {
        let parts = start.duration(to: end).components
        return max(0, Int((Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15).rounded()))
    }
}

/// Minted only by a current Core response. This identifies key custody; the
/// source-start gate still independently decides whether capture may begin.
struct NativeProviderRecordingPublicKey: Equatable, Sendable {
    let version: String
    let modulusBase64URL: String

    static func parse(_ value: [String: Any]) throws -> Self {
        guard Set(value.keys) == ["key_version", "algorithm", "public_jwk"],
              let version = value["key_version"] as? String,
              version.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              value["algorithm"] as? String == "RSA-OAEP-256",
              let jwk = value["public_jwk"] as? [String: Any],
              Set(jwk.keys) == ["kty", "n", "e", "alg", "ext", "key_ops"],
              jwk["kty"] as? String == "RSA", jwk["alg"] as? String == "RSA-OAEP-256",
              jwk["e"] as? String == "AQAB", jwk["key_ops"] as? [String] == ["wrapKey"],
              let ext = jwk["ext"] as? NSNumber, CFGetTypeID(ext) == CFBooleanGetTypeID(), ext.boolValue,
              let modulus = jwk["n"] as? String,
              modulus.range(of: "^[A-Za-z0-9_-]{512}$", options: .regularExpression) != nil,
              let bytes = Data(base64Encoded: modulus.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/")), bytes.count == 384,
              bytes.first.map({ $0 & 0x80 != 0 }) == true,
              bytes.last.map({ $0 & 1 == 1 }) == true else { throw ProviderNativeError.response }
        return Self(version: version, modulusBase64URL: modulus)
    }
}

struct NativeProviderRecordingContext: Equatable, Sendable {
    let bindingRef: String
    let workspaceID: UUID
    let tenantID: UUID
    let sessionID: UUID
    let accountDigest: String
    fileprivate let checkedAt: Date
    let preparedPublicKey: NativeProviderRecordingPublicKey?
    let preparedRevision: String
    let preparedKeyExpires: ContinuousClock.Instant
    fileprivate let preparedGeneration: UUID
    fileprivate init(bindingRef: String, workspaceID: UUID, tenantID: UUID, sessionID: UUID, accountDigest: String, checkedAt: Date,
                     preparedPublicKey: NativeProviderRecordingPublicKey?, preparedRevision: String, preparedKeyExpires: ContinuousClock.Instant,
                     preparedGeneration: UUID) {
        self.bindingRef = bindingRef
        self.workspaceID = workspaceID; self.tenantID = tenantID
        self.sessionID = sessionID; self.accountDigest = accountDigest; self.checkedAt = checkedAt
        self.preparedPublicKey = preparedPublicKey; self.preparedRevision = preparedRevision
        self.preparedKeyExpires = preparedKeyExpires
        self.preparedGeneration = preparedGeneration
    }
}

/// Namespace copied from a verified native Core mount response. Keeping only
/// these IDs avoids both a second mount request and renderer-chosen queue custody.
struct NativeProviderRecordingMount: Equatable, Sendable {
    let workspaceID: UUID
    let bindingRef: String
    let recoveryScope: UUID
    let recordingPreparationSupported: Bool
    let admissionPreparationSupported: Bool
    let appointmentRef: String?
    let desktopAdmissionMetadataSupported: Bool
    fileprivate init(workspaceID: UUID, bindingRef: String, recoveryScope: UUID,
                     recordingPreparationSupported: Bool, admissionPreparationSupported: Bool,
                     appointmentRef: String? = nil, desktopAdmissionMetadataSupported: Bool = false) {
        self.workspaceID = workspaceID; self.bindingRef = bindingRef
        self.recoveryScope = recoveryScope
        self.recordingPreparationSupported = recordingPreparationSupported
        self.admissionPreparationSupported = admissionPreparationSupported
        self.appointmentRef = appointmentRef
        self.desktopAdmissionMetadataSupported = desktopAdmissionMetadataSupported
    }
}

protocol ProviderNativeWire: Sendable {
    func send(_ request: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply
}

/// Binds the *existing* native session owner to the fixed provider receiver.
/// No SDK, token store, auth policy or permissive alternate identity is created.
@MainActor final class NativeProviderConnection {
    private let auth: NativeWorkspaceAuth
    private let wire: any ProviderNativeWire
    private let nativeAdmissionPreparationEnabled: Bool
    private let desktopInitialWindowEnabled: Bool
    private let desktopVisitSignInEnabled: Bool
    private let setupVisitSignInEnabled: Bool
    private let desktopWallNow: @MainActor () -> Date
    private var pending: [UUID: (revision: String, task: Task<ProviderNativeReply, Error>)] = [:]
    private var earlyCancellations: Set<UUID> = []
    private var closed = false
    private var recordingMounts: [UUID: (revision: String, mount: NativeProviderRecordingMount)] = [:]
    private struct VisitSignInTicket {
        let token: String, revision: String, account: String
        let identity: NativeAuthIdentity, mount: NativeProviderRecordingMount, epoch: UUID
        let mintedAt: ContinuousClock.Instant, mintedWall: Date, expires: ContinuousClock.Instant
    }
    private var visitSignIn: (mount: NativeProviderRecordingMount, epoch: UUID, preparationID: UUID?,
                              readyAt: ContinuousClock.Instant?, task: Task<VisitSignInTicket?, Never>)?
    private var visitSignInOwner: UUID?
    private var earlyVisitSignInCancellations: Set<UUID> = []
    private var visitSignInEpoch = UUID()
    private var visitSignInExpiry: Task<Void, Never>?

    private func abandonVisitSignIn() {
        visitSignInExpiry?.cancel(); visitSignInExpiry = nil
        visitSignIn?.task.cancel(); visitSignIn = nil; visitSignInOwner = nil; visitSignInEpoch = UUID()
    }

    private func visitSignInIsCurrent(_ ticket: VisitSignInTicket, revision: String) -> Bool {
        guard !closed, ticket.revision == revision, ticket.epoch == visitSignInEpoch,
              contextNow() >= ticket.mintedAt, contextNow() < ticket.expires,
              Self.desktopClocksAgree(from: ticket.mintedAt, wall: ticket.mintedWall,
                  to: contextNow(), wall: desktopWallNow()),
              auth.state().identity == ticket.identity,
              (try? auth.recordingAccountDigest(expectedRevision: revision)) == ticket.account,
              recordingMounts[ticket.mount.workspaceID]?.revision == revision,
              recordingMounts[ticket.mount.workspaceID]?.mount == ticket.mount,
              (try? auth.validateInitialWindowToken(ticket.token, expectedRevision: revision)) != nil
        else { return false }
        return true
    }

    /// Starts native-only auth work for the current mounted setup. This is an
    /// acknowledgement, not consent, source permission or recording authority.
    func prepareVisitSignIn(revision: String, workspaceID: String, bindingRef: String,
                            preparationID: String) throws {
        try current(revision)
        guard let workspace = Self.canonicalUUID(workspaceID),
              let owner = Self.canonicalUUID(preparationID),
              let saved = recordingMounts[workspace], saved.revision == revision,
              saved.mount.bindingRef == bindingRef, visitSignInSupported(saved.mount) else {
            throw ProviderNativeError.invalidRequest
        }
        guard earlyVisitSignInCancellations.remove(owner) == nil else { throw ProviderNativeError.cancelled }
        if let flight = visitSignIn, flight.preparationID == owner,
           flight.epoch == visitSignInEpoch, flight.mount == saved.mount,
           flight.readyAt.map({ contextNow() < $0.advanced(by: .seconds(1)) }) ?? true {
            return // A duplicate setup/config/consent event joins the same mint.
        }
        startVisitSignIn(mount: saved.mount, revision: revision, preparationID: owner)
    }

    func abandonVisitSignIn(preparationID: String) throws {
        guard let owner = Self.canonicalUUID(preparationID) else { throw ProviderNativeError.invalidRequest }
        if visitSignInOwner == owner { abandonVisitSignIn() }
        else if !closed {
            guard earlyVisitSignInCancellations.count < 256 else { throw ProviderNativeError.unavailable }
            earlyVisitSignInCancellations.insert(owner)
        }
    }

    private func visitSignInSupported(_ mount: NativeProviderRecordingMount) -> Bool {
        (desktopVisitSignInEnabled && desktopInitialWindowEnabled && mount.desktopAdmissionMetadataSupported)
            || (setupVisitSignInEnabled && nativeAdmissionPreparationEnabled && mount.admissionPreparationSupported)
    }

    private func prepareVisitSignIn(after request: ProviderNativeRequest) {
        guard !setupVisitSignInEnabled, desktopVisitSignInEnabled, desktopInitialWindowEnabled, request.action == .mount,
              let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let workspace = Self.canonicalUUID(body["workspace_id"] as? String),
              let saved = recordingMounts[workspace], saved.revision == request.revision,
              saved.mount.desktopAdmissionMetadataSupported else { return }
        startVisitSignIn(mount: saved.mount, revision: request.revision, preparationID: nil)
    }

    private func startVisitSignIn(mount: NativeProviderRecordingMount, revision: String, preparationID: UUID?) {
        abandonVisitSignIn()
        let epoch = visitSignInEpoch, workspace = mount.workspaceID
        visitSignInOwner = preparationID
        let task = Task { @MainActor [weak self] () -> VisitSignInTicket? in
            guard let self else { return nil }
            do {
                try self.current(revision)
                let identity = self.auth.state().identity
                let account = try self.auth.recordingAccountDigest(expectedRevision: revision)
                let token = try await self.auth.prepareToken(expectedRevision: revision)
                try Task.checkCancellation(); try self.current(revision)
                guard let identity, self.auth.state().identity == identity,
                      self.visitSignInEpoch == epoch,
                      self.recordingMounts[workspace]?.mount == mount else { return nil }
                let mintedAt = self.contextNow(), wall = self.desktopWallNow()
                let jwtExpiry = try self.auth.validateInitialWindowToken(token, expectedRevision: revision)
                let deadline = min(mintedAt.advanced(by: .seconds(5)),
                    mintedAt.advanced(by: .seconds(jwtExpiry.timeIntervalSince(wall))))
                guard mintedAt < deadline else { return nil }
                let ticket = VisitSignInTicket(token: token, revision: revision, account: account,
                    identity: identity, mount: mount, epoch: epoch, mintedAt: mintedAt,
                    mintedWall: wall, expires: deadline)
                self.visitSignIn?.readyAt = mintedAt
                self.visitSignInExpiry = Task { @MainActor [weak self] in
                    try? await Task.sleep(until: deadline, clock: ContinuousClock())
                    guard !Task.isCancelled, self?.visitSignIn?.epoch == epoch else { return }
                    self?.visitSignIn = nil; self?.visitSignInExpiry = nil
                }
                return ticket
            } catch {
                if self.visitSignIn?.epoch == epoch { self.visitSignIn = nil; self.visitSignInOwner = nil }
                return nil
            }
        }
        visitSignIn = (mount, epoch, preparationID, nil, task)
    }

    private func claimVisitSignIn(_ request: ProviderNativeRequest) -> Task<VisitSignInTicket?, Never>? {
        let saved = visitSignIn
        visitSignIn = nil; visitSignInExpiry?.cancel(); visitSignInExpiry = nil
        guard request.action == .admission,
              let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              body["attestation"] is [String: Any],
              Self.canonicalUUID(body["request_nonce"] as? String) != nil,
              let saved, saved.epoch == visitSignInEpoch,
              body["workspace_id"] as? String == saved.mount.workspaceID.uuidString.lowercased(),
              body["binding_ref"] as? String == saved.mount.bindingRef else {
            saved?.task.cancel(); visitSignInOwner = nil; visitSignInEpoch = UUID(); return nil
        }
        let original: Set<String> = ["workspace_id", "binding_ref", "request_nonce", "attestation", "configured_capture"]
        let native = setupVisitSignInEnabled && nativeAdmissionPreparationEnabled
            && saved.mount.admissionPreparationSupported && Set(body.keys) == original
        let optIn = body["preparation_metadata"] as? NSNumber
        let desktop = desktopVisitSignInEnabled && desktopInitialWindowEnabled
            && saved.mount.desktopAdmissionMetadataSupported && Set(body.keys) == original.union(["preparation_metadata"])
            && optIn.map({ CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue }) == true
        guard native || desktop else {
            saved.task.cancel(); visitSignInOwner = nil; visitSignInEpoch = UUID(); return nil
        }
        // One destructive claim before native augmentation/any await. No restore
        // or I/O retry. Explicit owner cancellation still fences a claimed mint.
        return saved.task
    }

    private struct PreparedRecordingContext {
        let requestID: UUID, nonce: UUID, revision: String
        let mount: NativeProviderRecordingMount, context: NativeProviderRecordingContext
        let expires: ContinuousClock.Instant
    }
    private var preparedRecording: PreparedRecordingContext?
    private struct PreparedAdmissionContext {
        let requestID: UUID, revision: String
        let mount: NativeProviderRecordingMount, context: NativeProviderRecordingContext
        let expires: ContinuousClock.Instant
    }
    private var preparedAdmission: PreparedAdmissionContext?
    private struct InitialWindowTicket {
        let token: String
        let identity: NativeAuthIdentity
        let revision: String, admissionKey: String, account: String, binding: String
        var generation: UUID
        let epoch: UUID, workspace: UUID, session: UUID, tenant: UUID, recovery: UUID
        let mintedAt: ContinuousClock.Instant, expires: ContinuousClock.Instant
    }
    private var initialWindowTicket: InitialWindowTicket?
    private var initialWindowEpoch = UUID()
    private var initialWindowExpiry: Task<Void, Never>?

    // Desktop has no tenant-bearing native-recording context on this wire.
    // Bind only the complete existing desktop account/mount/admission contract.
    private struct DesktopInitialWindowTicket {
        let token: String, identity: NativeAuthIdentity
        let revision: String, account: String, admissionKey: String, admissionNonce: String
        let receipt: Data, session: UUID, keyVersion: String
        let mount: NativeProviderRecordingMount, epoch: UUID
        let mintedAt: ContinuousClock.Instant, expires: ContinuousClock.Instant
        let clockAt: ContinuousClock.Instant, clockWall: Date
        var sourceScope: DesktopSourceScope {
            DesktopSourceScope(token: token, identity: identity, revision: revision, account: account,
                mount: mount, epoch: epoch, mintedAt: mintedAt, expires: expires,
                clockAt: clockAt, clockWall: clockWall)
        }
    }
    private struct DesktopSourceScope {
        let token: String, identity: NativeAuthIdentity, revision: String, account: String
        let mount: NativeProviderRecordingMount, epoch: UUID
        let mintedAt: ContinuousClock.Instant, expires: ContinuousClock.Instant
        let clockAt: ContinuousClock.Instant, clockWall: Date
    }
    private var desktopInitialWindowTicket: DesktopInitialWindowTicket?
    private var desktopInitialWindowEpoch = UUID()
    private var desktopInitialWindowExpiry: Task<Void, Never>?
    private struct DesktopSourceStartTicket {
        // Keep the admission's original token, clocks and deadline. Transfer
        // after window publication cannot mint a new five-second interval.
        let scope: DesktopSourceScope
        let preparation: NativeSourcePreparation
        // Initial admission provides a known consent. A freshly prepared
        // continuation instead relies on Core's current consent decision pair.
        let consent: String?
    }
    private var desktopSourceStartTicket: DesktopSourceStartTicket?
    private var desktopSourceStartExpiry: Task<Void, Never>?

    func abandonDesktopInitialWindow() {
        desktopInitialWindowExpiry?.cancel(); desktopInitialWindowExpiry = nil
        desktopSourceStartExpiry?.cancel(); desktopSourceStartExpiry = nil
        desktopSourceStartTicket = nil
        desktopInitialWindowTicket = nil; desktopInitialWindowEpoch = UUID()
    }

    func abandonFreshInitialWindow() {
        initialWindowExpiry?.cancel(); initialWindowExpiry = nil
        initialWindowTicket = nil; initialWindowEpoch = UUID()
    }
    private var preparingAdmission: UUID?
    private var preparingRecording: UUID?
    private var recordingGeneration = UUID()
    private let contextNow: @MainActor () -> ContinuousClock.Instant
    private let timingNow: @MainActor () -> ContinuousClock.Instant
    private let requestTiming: @MainActor (ProviderNativeRequestTiming) -> Void

    init(auth: NativeWorkspaceAuth, wire: any ProviderNativeWire,
         nativeAdmissionPreparationEnabled: Bool = false,
         desktopInitialWindowEnabled: Bool = false,
         desktopVisitSignInEnabled: Bool = false, setupVisitSignInEnabled: Bool = false,
         desktopWallNow: @escaping @MainActor () -> Date = { Date() },
         contextNow: @escaping @MainActor () -> ContinuousClock.Instant = { .now },
         timingNow: @escaping @MainActor () -> ContinuousClock.Instant = { .now },
         requestTiming: @escaping @MainActor (ProviderNativeRequestTiming) -> Void = { $0.log() }) {
        self.auth = auth; self.wire = wire; self.contextNow = contextNow
        self.nativeAdmissionPreparationEnabled = nativeAdmissionPreparationEnabled
        self.desktopInitialWindowEnabled = desktopInitialWindowEnabled
        self.desktopVisitSignInEnabled = desktopVisitSignInEnabled
        self.setupVisitSignInEnabled = setupVisitSignInEnabled
        self.desktopWallNow = desktopWallNow
        self.timingNow = timingNow; self.requestTiming = requestTiming
    }

    func authChanged(_ state: NativeAuthState) {
        abandonVisitSignIn()
        abandonFreshInitialWindow()
        abandonDesktopInitialWindow()
        preparingAdmission = nil
        preparedAdmission = nil
        preparedRecording = nil; recordingGeneration = UUID()
        recordingMounts = recordingMounts.filter { state.phase == .ready && $0.value.revision == state.revision }
        for (_, operation) in pending where state.phase != .ready || operation.revision != state.revision {
            operation.task.cancel()
        }
    }

    func cancel(_ id: UUID) {
        abandonVisitSignIn()
        abandonFreshInitialWindow()
        abandonDesktopInitialWindow()
        if preparingAdmission == id { preparingAdmission = nil }
        if preparedAdmission?.requestID == id { preparedAdmission = nil }
        if preparedRecording?.requestID == id || preparingRecording == id {
            preparedRecording = nil; recordingGeneration = UUID()
        }
        if let operation = pending[id] { operation.task.cancel(); return }
        // Capacitor promise calls can be cancelled before their MainActor task
        // enters send(). Keep that cancellation, never dispatch it afterward.
        guard earlyCancellations.count < 1024 else { close(); return }
        earlyCancellations.insert(id)
    }

    func close() {
        abandonVisitSignIn()
        abandonFreshInitialWindow()
        abandonDesktopInitialWindow()
        closed = true
        preparingAdmission = nil
        preparedAdmission = nil
        preparedRecording = nil; recordingGeneration = UUID()
        recordingMounts.removeAll()
        for (_, operation) in pending { operation.task.cancel() }
    }

    /// Native-only cessation recovery after the same account signs in again.
    /// The immutable connection retains its original issuer/transport policy.
    func stopRevision(for identity: NativeAuthIdentity) throws -> String {
        try stopRevision(userID: identity.userID, organizationID: identity.organizationID)
    }

    func stopRevision(userID: String, organizationID: String?) throws -> String {
        let state = auth.state()
        guard !closed, state.phase == .ready, let current = state.identity,
              current.userID == userID, current.organizationID == organizationID else {
            throw ProviderNativeError.unavailable
        }
        return state.revision
    }

    /// A fresh SDK session for the same native account may recover its keys.
    /// The account namespace includes issuer, audience, origin and organization.
    func recordingRevision(accountDigest: String) throws -> String {
        let state = auth.state()
        try current(state.revision)
        guard try auth.recordingAccountDigest(expectedRevision: state.revision) == accountDigest else {
            throw ProviderNativeError.unavailable
        }
        return state.revision
    }

    func passageAccountDigest(revision: String) throws -> String {
        try current(revision)
        return try auth.recordingAccountDigest(expectedRevision: revision)
    }

    func recordingMount(workspaceID: UUID, bindingRef: String, revision: String) throws -> NativeProviderRecordingMount {
        try current(revision)
        guard let saved = recordingMounts[workspaceID], saved.revision == revision,
              saved.mount.bindingRef == bindingRef else { throw ProviderNativeError.unavailable }
        return saved.mount
    }

    /// Native-only key preparation input. Neither tenant nor account is taken
    /// from a renderer request, Core authority-tenant reference, or saved form.
    func recordingContext(workspaceID: UUID, bindingRef: String, sessionID: UUID,
                          revision: String, requestID: UUID = UUID()) async throws -> NativeProviderRecordingContext {
        try current(revision)
        guard bindingRef.range(of: "^scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}$",
                               options: .regularExpression) != nil else {
            throw ProviderNativeError.invalidRequest
        }
        let account = try auth.recordingAccountDigest(expectedRevision: revision)
        let mounted = recordingMounts[workspaceID]
        let combined = mounted?.revision == revision && mounted?.mount.bindingRef == bindingRef
            && mounted?.mount.recordingPreparationSupported == true
        let kind = combined ? "native_recording_preparation" : "native_recording_context"
        let nonce = UUID().uuidString.lowercased()
        let body = try JSONSerialization.data(withJSONObject: [
            "workspace_id": workspaceID.uuidString.lowercased(), "binding_ref": bindingRef,
            "request_nonce": nonce, "operation": ["kind": kind],
        ])
        let request = try ProviderNativeRequest(id: requestID.uuidString.lowercased(), revision: revision,
            action: "capture-operations", key: UUID().uuidString.lowercased(),
            body: String(decoding: body, as: UTF8.self))
        let reply = try await send(request)
        try current(revision)
        try Self.requireRecordingResponse(reply.status)
        guard try auth.recordingAccountDigest(expectedRevision: revision) == account,
              reply.status == 200, reply.body.count <= 8192,
              let value = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(value.keys) == ["contract_version", "binding_ref", "workspace_id", "request_nonce",
                                  "checked_at", "operation", "receipt"],
              value["contract_version"] as? String == "1",
              value["workspace_id"] as? String == workspaceID.uuidString.lowercased(),
              value["binding_ref"] as? String == bindingRef,
              value["request_nonce"] as? String == nonce,
              value["operation"] as? String == kind,
              let checked = value["checked_at"] as? String, let checkedAt = Self.recentRecordingCheck(checked),
              let rawReceipt = value["receipt"] as? [String: Any] else {
            throw ProviderNativeError.response
        }
        let receipt: [String: Any]
        let publicKey: NativeProviderRecordingPublicKey?
        if combined {
            guard Set(rawReceipt.keys) == ["schema_version", "context", "encryption_key"],
                  rawReceipt["schema_version"] as? String == "1.0",
                  let context = rawReceipt["context"] as? [String: Any],
                  let key = rawReceipt["encryption_key"] as? [String: Any] else {
                throw ProviderNativeError.response
            }
            receipt = context; publicKey = try NativeProviderRecordingPublicKey.parse(key)
        } else {
            receipt = rawReceipt; publicKey = nil
        }
        guard
              Set(receipt.keys) == ["schema_version", "workspace_id", "tenant_id", "session_id", "status"],
              receipt["schema_version"] as? String == "1.0",
              receipt["workspace_id"] as? String == workspaceID.uuidString.lowercased(),
              receipt["session_id"] as? String == sessionID.uuidString.lowercased(),
              let tenant = receipt["tenant_id"] as? String, let tenantID = UUID(uuidString: tenant),
              tenantID.uuidString.lowercased() == tenant,
              let status = receipt["status"] as? String, ["created", "capturing"].contains(status) else {
            throw ProviderNativeError.response
        }
        return NativeProviderRecordingContext(bindingRef: bindingRef, workspaceID: workspaceID, tenantID: tenantID,
            sessionID: sessionID, accountDigest: account, checkedAt: checkedAt,
            preparedPublicKey: publicKey, preparedRevision: revision,
            preparedKeyExpires: contextNow().advanced(by: .seconds(max(0, min(5, 30 - Date().timeIntervalSince(checkedAt))))),
            preparedGeneration: recordingGeneration)
    }

    func recordingPreparationKeyIsCurrent(_ context: NativeProviderRecordingContext) throws -> Bool {
        let revision = try recordingRevision(accountDigest: context.accountDigest)
        return revision == context.preparedRevision && recordingGeneration == context.preparedGeneration
            && contextNow() < context.preparedKeyExpires
    }

    /// Reuse the same fresh Core check before renderer custody inspection and
    /// native open. Only an acknowledgement crosses the bridge, never the tenant.
    /// This single-use metadata does not grant microphone or source permission.
    func prepareRecordingContext(_ request: ProviderNativeRequest) async throws -> ProviderNativeReply {
        // A local handoff must keep send()'s cancellation fence even when no
        // token/network request is needed to prepare this recording.
        try Task.checkCancellation()
        guard earlyCancellations.remove(request.id) == nil else {
            preparedAdmission = nil; preparedRecording = nil; recordingGeneration = UUID()
            abandonFreshInitialWindow()
            throw ProviderNativeError.cancelled
        }
        preparingAdmission = nil
        preparedRecording = nil
        let priorGeneration = recordingGeneration
        let ticket = UUID(); recordingGeneration = ticket
        var transferred = false
        defer { if !transferred { abandonFreshInitialWindow() } }
        preparingRecording = request.id
        defer { if preparingRecording == request.id { preparingRecording = nil } }
        try current(request.revision)
        guard request.action == .recorderContext,
              let body = try JSONSerialization.jsonObject(with: request.body) as? [String: String],
              Set(body.keys) == ["workspace_id", "binding_ref", "session_id", "request_nonce"],
              let workspace = Self.canonicalUUID(body["workspace_id"]),
              let session = Self.canonicalUUID(body["session_id"]),
              let nonce = Self.canonicalUUID(body["request_nonce"]), let binding = body["binding_ref"] else {
            throw ProviderNativeError.invalidRequest
        }
        let mount = try recordingMount(workspaceID: workspace, bindingRef: binding, revision: request.revision)
        let retained = preparedAdmission
        preparedAdmission = nil
        let context: NativeProviderRecordingContext
        if let retained, retained.revision == request.revision, retained.mount == mount,
           retained.context.sessionID == session, contextNow() < retained.expires,
           retained.context.accountDigest == (try auth.recordingAccountDigest(expectedRevision: request.revision)) {
            // Admission and its metadata read already finished their fresh Core
            // publication fences. Transfer once within the existing five-second
            // bound; microphone/source authorization still runs on Start.
            context = NativeProviderRecordingContext(bindingRef: binding, workspaceID: workspace,
                tenantID: retained.context.tenantID, sessionID: session,
                accountDigest: retained.context.accountDigest, checkedAt: retained.context.checkedAt,
                preparedPublicKey: retained.context.preparedPublicKey, preparedRevision: request.revision,
                preparedKeyExpires: retained.expires, preparedGeneration: ticket)
            if var saved = initialWindowTicket, saved.generation == priorGeneration,
               saved.revision == request.revision, saved.workspace == workspace,
               saved.session == session, saved.tenant == context.tenantID,
               saved.account == context.accountDigest, saved.binding == binding,
               saved.recovery == mount.recoveryScope, saved.epoch == initialWindowEpoch,
               saved.identity == auth.state().identity, contextNow() >= saved.mintedAt,
               contextNow() < saved.expires {
                // Transfer with the exact single-use admission metadata. Only the
                // owner generation changes; neither original clock bound is renewed.
                saved.generation = ticket; initialWindowTicket = saved
            } else { abandonFreshInitialWindow() }
        } else {
            context = try await recordingContext(workspaceID: workspace, bindingRef: binding,
                sessionID: session, revision: request.revision, requestID: request.id)
        }
        try current(request.revision)
        try Task.checkCancellation()
        guard ticket == recordingGeneration,
              try recordingMount(workspaceID: workspace, bindingRef: binding, revision: request.revision) == mount else {
            throw ProviderNativeError.authorityChanged
        }
        // Include the original server freshness bound and use monotonic elapsed
        // time, so clock changes cannot extend reuse. Expiry causes a fresh read.
        preparedRecording = PreparedRecordingContext(requestID: request.id, nonce: nonce,
            revision: request.revision, mount: mount, context: context,
            expires: context.preparedKeyExpires)
        transferred = true
        return ProviderNativeReply(status: 200, body: try JSONSerialization.data(withJSONObject: [
            "revision": request.revision, "session_id": session.uuidString.lowercased(),
            "authorization_id": nonce.uuidString.lowercased(),
        ]))
    }

    func takePreparedRecordingContext(nonce: UUID, workspaceID: UUID, bindingRef: String,
                                      sessionID: UUID, revision: String) throws -> NativeProviderRecordingContext? {
        let saved = preparedRecording
        preparedRecording = nil
        var transferred = false
        defer { if !transferred { recordingGeneration = UUID(); abandonFreshInitialWindow() } }
        try current(revision)
        guard let saved, saved.nonce == nonce, saved.revision == revision,
              saved.context.workspaceID == workspaceID, saved.context.bindingRef == bindingRef,
              saved.context.sessionID == sessionID,
              saved.context.accountDigest == (try auth.recordingAccountDigest(expectedRevision: revision)),
              try recordingMount(workspaceID: workspaceID, bindingRef: bindingRef, revision: revision) == saved.mount else {
            throw ProviderNativeError.authorityChanged
        }
        guard contextNow() < saved.expires else {
            return nil
        }
        // Consuming this ticket transfers its context to one native service.
        // Keep that same generation for the bundled single-use public key.
        transferred = true
        return saved.context
    }

    private static func canonicalUUID(_ value: String?) -> UUID? {
        guard let value, let id = UUID(uuidString: value), id.uuidString.lowercased() == value else { return nil }
        return id
    }

    private static func recentRecordingCheck(_ value: String) -> Date? {
        guard value.utf8.count <= 40 else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var checked = parser.date(from: value)
        if checked == nil { parser.formatOptions = [.withInternetDateTime]; checked = parser.date(from: value) }
        guard let checked else { return nil }
        let age = Date().timeIntervalSince(checked)
        return age >= -5 && age <= 30 ? checked : nil
    }

    /// Explicit Core denial retires capture; only an unavailable transport/service
    /// may be retried within the already granted short native window.
    static func requireRecordingResponse(_ status: Int) throws {
        if [401, 403, 409, 422].contains(status) {
            throw ProviderNativeError.authorityChanged
        }
        if status == 503 { throw ProviderNativeError.unavailable }
        guard status == 200 else { throw ProviderNativeError.response }
    }

    private func rememberRecordingMount(_ request: ProviderNativeRequest, _ reply: ProviderNativeReply) {
        guard request.action == .mount,
              let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let workspace = body["workspace_id"] as? String, let id = UUID(uuidString: workspace),
              id.uuidString.lowercased() == workspace else { return }
        recordingMounts.removeValue(forKey: id)
        let opening = request.openingNonce
        let bodyKeys: Set<String> = opening == nil ? ["workspace_id"] : ["workspace_id", "opening_nonce"]
        var replyKeys: Set<String> = ["revision", "recoveryScope", "workspaceId", "appointmentRef", "bindingRef", "encounter"]
        if opening != nil { replyKeys.insert("openingReview") }
        guard Set(body.keys) == bodyKeys, reply.status == 200, reply.body.count <= request.responseLimit,
              let value = try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(value.keys) == replyKeys,
              value["revision"] as? String == request.revision,
              value["workspaceId"] as? String == workspace,
              let recovery = value["recoveryScope"] as? String, let scope = UUID(uuidString: recovery),
              scope.uuidString.lowercased() == recovery,
              let binding = value["bindingRef"] as? String,
              binding.range(of: "^scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil,
              let appointment = value["appointmentRef"] as? String,
              appointment.range(of: "^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil,
              let encounter = value["encounter"] as? [String: Any], encounter["appointmentRef"] as? String == appointment,
              recordingMounts.count < 100 else { return }
        if let opening {
            guard let review = value["openingReview"] as? [String: Any],
                  review["contract_version"] as? String == "1",
                  review["workspace_id"] as? String == workspace,
                  review["binding_ref"] as? String == binding,
                  review["request_nonce"] as? String == opening.uuidString.lowercased(),
                  review["operation"] as? String == "provider_encounter" else { return }
        }
        var preparationSupported = false
        if let rawCapability = encounter["native_recording_preparation_v1"] {
            guard let capability = rawCapability as? NSNumber,
                  CFGetTypeID(capability) == CFBooleanGetTypeID() else { return }
            preparationSupported = capability.boolValue
        }
        var admissionSupported = false
        if let rawCapability = encounter["admission_native_preparation_v1"] {
            guard let capability = rawCapability as? NSNumber,
                  CFGetTypeID(capability) == CFBooleanGetTypeID() else { return }
            admissionSupported = capability.boolValue
        }
        var desktopSupported = false
        if desktopInitialWindowEnabled, let rawCapability = encounter["admission_metadata_v1"] {
            guard let capability = rawCapability as? NSNumber,
                  CFGetTypeID(capability) == CFBooleanGetTypeID() else { return }
            desktopSupported = capability.boolValue
        }
        recordingMounts[id] = (request.revision, NativeProviderRecordingMount(
            workspaceID: id, bindingRef: binding, recoveryScope: scope,
            recordingPreparationSupported: preparationSupported,
            admissionPreparationSupported: admissionSupported,
            appointmentRef: desktopInitialWindowEnabled ? appointment : nil,
            desktopAdmissionMetadataSupported: desktopSupported))
    }

    /// Opt in only for fresh consent on a mount advertised by our receiver.
    /// The renderer cannot select or supply the native metadata or its scope.
    private func admissionPreparationRequest(_ request: ProviderNativeRequest) throws -> ProviderNativeRequest {
        guard request.action == .admission else { return request }
        guard nativeAdmissionPreparationEnabled else { return request }
        preparedAdmission = nil; preparedRecording = nil
        preparingAdmission = nil; recordingGeneration = UUID()
        if let body = try JSONSerialization.jsonObject(with: request.body) as? [String: Any],
           body["native_recording_preparation"] != nil { throw ProviderNativeError.invalidRequest }
        guard var body = try JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "attestation", "configured_capture"],
              body["attestation"] is [String: Any],
              let workspace = Self.canonicalUUID(body["workspace_id"] as? String),
              let binding = body["binding_ref"] as? String,
              let saved = recordingMounts[workspace], saved.revision == request.revision,
              saved.mount.bindingRef == binding, saved.mount.admissionPreparationSupported else { return request }
        body["native_recording_preparation"] = true
        let augmented = try ProviderNativeRequest(id: request.id.uuidString.lowercased(),
            revision: request.revision, action: request.action.rawValue, key: request.key,
            body: String(decoding: JSONSerialization.data(withJSONObject: body), as: UTF8.self))
        preparingAdmission = request.id
        return augmented
    }

    private func takeAdmissionPreparationReply(_ request: ProviderNativeRequest,
                                               _ reply: ProviderNativeReply, token: String,
                                               mintedAt: ContinuousClock.Instant) throws -> ProviderNativeReply {
        guard request.action == .admission,
              let body = try JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              body["native_recording_preparation"] as? Bool == true else { return reply }
        guard preparingAdmission == request.id,
              let workspace = Self.canonicalUUID(body["workspace_id"] as? String),
              let binding = body["binding_ref"] as? String,
              let nonce = body["request_nonce"] as? String, Self.canonicalUUID(nonce) != nil,
              let mounted = recordingMounts[workspace], mounted.revision == request.revision,
              mounted.mount.bindingRef == binding, mounted.mount.admissionPreparationSupported,
              reply.body.count <= 8192,
              let value = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(value.keys) == ["contract_version", "workspace_id", "binding_ref", "request_nonce", "checked_at",
                                  "appointment_ref", "operation_ref", "consent_record_id", "session_id", "status",
                                  "configured_capture", "native_recording_preparation"],
              value["contract_version"] as? String == "1", value["workspace_id"] as? String == workspace.uuidString.lowercased(),
              value["binding_ref"] as? String == binding, value["request_nonce"] as? String == nonce,
              value["status"] as? String == "admitted",
              let configured = value["configured_capture"] as? NSDictionary,
              let requested = body["configured_capture"] as? NSDictionary, configured == requested,
              let appointment = value["appointment_ref"] as? String,
              appointment.range(of: "^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil,
              let operation = value["operation_ref"] as? String,
              operation.range(of: "^scribe_admission_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil,
              let session = Self.canonicalUUID(value["session_id"] as? String),
              Self.canonicalUUID(value["consent_record_id"] as? String) != nil,
              let checked = value["checked_at"] as? String, let checkedAt = Self.recentRecordingCheck(checked),
              let metadata = value["native_recording_preparation"] as? [String: Any],
              Set(metadata.keys) == ["schema_version", "context", "encryption_key"], metadata["schema_version"] as? String == "1.0",
              let context = metadata["context"] as? [String: Any],
              Set(context.keys) == ["schema_version", "workspace_id", "tenant_id", "session_id", "status"],
              context["schema_version"] as? String == "1.0", context["workspace_id"] as? String == workspace.uuidString.lowercased(),
              context["session_id"] as? String == session.uuidString.lowercased(),
              let tenant = Self.canonicalUUID(context["tenant_id"] as? String),
              let status = context["status"] as? String, ["created", "capturing"].contains(status),
              let key = metadata["encryption_key"] as? [String: Any] else { throw ProviderNativeError.response }
        let publicKey = try NativeProviderRecordingPublicKey.parse(key)
        let expires = contextNow().advanced(by: .seconds(max(0, min(5, 30 - Date().timeIntervalSince(checkedAt)))))
        let retained = NativeProviderRecordingContext(bindingRef: binding, workspaceID: workspace, tenantID: tenant,
            sessionID: session, accountDigest: try auth.recordingAccountDigest(expectedRevision: request.revision),
            checkedAt: checkedAt, preparedPublicKey: publicKey, preparedRevision: request.revision,
            preparedKeyExpires: expires, preparedGeneration: recordingGeneration)
        preparedAdmission = PreparedAdmissionContext(requestID: request.id, revision: request.revision,
            mount: mounted.mount, context: retained, expires: expires)
        let now = contextNow()
        // The optional ticket must not reject an otherwise successful admission
        // whose original JWT expires while the receiver is responding.
        if status == "created", now >= mintedAt,
           let jwtExpiry = try? auth.validateInitialWindowToken(token, expectedRevision: request.revision),
           let identity = auth.state().identity {
            let deadline = min(expires, mintedAt.advanced(by: .seconds(5)),
                               now.advanced(by: .seconds(max(0, jwtExpiry.timeIntervalSinceNow))))
            guard now < deadline else { return try Self.stripAdmissionMetadata(value, reply: reply) }
            initialWindowTicket = InitialWindowTicket(token: token, identity: identity,
                revision: request.revision, admissionKey: request.key, account: retained.accountDigest,
                binding: binding, generation: recordingGeneration, epoch: initialWindowEpoch,
                workspace: workspace, session: session,
                tenant: tenant, recovery: mounted.mount.recoveryScope, mintedAt: mintedAt, expires: deadline)
            let epoch = initialWindowEpoch
            initialWindowExpiry = Task { @MainActor [weak self] in
                try? await Task.sleep(until: deadline, clock: ContinuousClock())
                guard !Task.isCancelled, self?.initialWindowEpoch == epoch else { return }
                self?.abandonFreshInitialWindow()
            }
        }
        // Native storage namespace/key metadata never enters renderer custody.
        return try Self.stripAdmissionMetadata(value, reply: reply)
    }

    private static func stripAdmissionMetadata(_ value: [String: Any], reply: ProviderNativeReply) throws -> ProviderNativeReply {
        var value = value
        value.removeValue(forKey: "native_recording_preparation")
        return ProviderNativeReply(status: reply.status, body: try JSONSerialization.data(withJSONObject: value),
            serverTiming: reply.serverTiming, coreTiming: reply.coreTiming)
    }

    func send(_ request: ProviderNativeRequest) async throws -> ProviderNativeReply {
        abandonFreshInitialWindow()
        abandonDesktopInitialWindow()
        return try await sendNative(request, initialWindowToken: nil)
    }

    /// Only trusted desktop main calls this after its one-use clean-custody proof.
    /// A miss before I/O takes the original fresh path; uncertain I/O never retries.
    func sendFreshDesktopInitialWindow(_ request: ProviderNativeRequest, admissionKey: String,
                                      admissionNonce: String, admissionReceipt: Data,
                                      beforeDispatch: @MainActor () async throws -> Void = {}) async throws -> ProviderNativeReply {
        let saved = desktopInitialWindowTicket
        desktopInitialWindowExpiry?.cancel(); desktopInitialWindowExpiry = nil
        desktopSourceStartExpiry?.cancel(); desktopSourceStartExpiry = nil
        desktopSourceStartTicket = nil
        desktopInitialWindowTicket = nil // Destructive claim before validation or await.
        var retained: DesktopInitialWindowTicket?
        if desktopInitialWindowEnabled, let saved,
           saved.admissionKey == admissionKey, saved.admissionNonce == admissionNonce,
           let row = try? JSONSerialization.jsonObject(with: admissionReceipt) as? [String: Any],
           (try? Self.desktopCanonical(row)) == saved.receipt,
           desktopTicketIsCurrent(saved, revision: request.revision),
           Self.isDesktopInitialWindow(request, ticket: saved) {
            retained = saved
        } else { abandonDesktopInitialWindow() }
        try await beforeDispatch()
        return try await sendNative(request, initialWindowToken: nil, desktopWindowToken: retained)
    }

    /// NativeSourceStartOwner is the only caller. Generic renderer requests
    /// cannot construct sourceStartReady or claim this one-use RAM handoff.
    func sendFreshDesktopSourceStart(_ request: ProviderNativeRequest,
                                     preparation: NativeSourcePreparation) async throws -> ProviderNativeReply {
        let saved = desktopSourceStartTicket
        desktopSourceStartExpiry?.cancel(); desktopSourceStartExpiry = nil
        desktopSourceStartTicket = nil // Claim before validation or any await.
        abandonFreshInitialWindow()
        var retained: DesktopSourceStartTicket?
        if let saved, saved.preparation == preparation,
           desktopTicketIsCurrent(saved.scope, revision: request.revision),
           Self.isDesktopSourceStart(request, ticket: saved) {
            retained = saved
        } else { abandonDesktopInitialWindow() }
        return try await sendNative(request, initialWindowToken: nil, desktopSourceToken: retained)
    }

    private func desktopPublicationIsCurrent(_ ticket: DesktopInitialWindowTicket, revision: String) -> Bool {
        guard !closed, ticket.revision == revision, ticket.epoch == desktopInitialWindowEpoch,
              auth.state().phase == .ready, auth.state().revision == revision,
              auth.state().identity == ticket.identity,
              (try? auth.recordingAccountDigest(expectedRevision: revision)) == ticket.account,
              recordingMounts[ticket.mount.workspaceID]?.revision == revision,
              recordingMounts[ticket.mount.workspaceID]?.mount == ticket.mount else { return false }
        return true
    }

    private func desktopTicketIsCurrent(_ ticket: DesktopInitialWindowTicket, revision: String) -> Bool {
        guard desktopPublicationIsCurrent(ticket, revision: revision), contextNow() < ticket.expires,
              Self.desktopClocksAgree(from: ticket.clockAt, wall: ticket.clockWall,
                                     to: contextNow(), wall: desktopWallNow()),
              (try? auth.validateInitialWindowToken(ticket.token, expectedRevision: revision)) != nil else { return false }
        return true
    }

    private func desktopPublicationIsCurrent(_ ticket: DesktopSourceScope, revision: String) -> Bool {
        !closed && ticket.revision == revision && ticket.epoch == desktopInitialWindowEpoch
            && auth.state().phase == .ready && auth.state().revision == revision
            && auth.state().identity == ticket.identity
            && (try? auth.recordingAccountDigest(expectedRevision: revision)) == ticket.account
            && recordingMounts[ticket.mount.workspaceID]?.revision == revision
            && recordingMounts[ticket.mount.workspaceID]?.mount == ticket.mount
    }

    private func desktopTicketIsCurrent(_ ticket: DesktopSourceScope, revision: String) -> Bool {
        desktopPublicationIsCurrent(ticket, revision: revision)
            && contextNow() >= ticket.mintedAt && contextNow() < ticket.expires
            && Self.desktopClocksAgree(from: ticket.clockAt, wall: ticket.clockWall,
                                      to: contextNow(), wall: desktopWallNow())
            && (try? auth.validateInitialWindowToken(ticket.token, expectedRevision: revision)) != nil
    }

    private static func desktopSourceTicket(_ reply: ProviderNativeReply,
                                            admission: DesktopInitialWindowTicket) -> DesktopSourceStartTicket? {
        // A legacy/partial receipt remains valid for its existing consumers but
        // cannot transfer a credential. Only the complete fresh mixed window
        // with generation one and thirty consecutive reservations is eligible.
        guard reply.status == 200, reply.body.count <= 65536,
              let value = try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              let receipt = value["receipt"] as? [String: Any],
              Set(receipt.keys) == ["schema_version", "binding", "lease", "reservations"],
              receipt["schema_version"] as? String == "1.0",
              let binding = receipt["binding"] as? [String: Any],
              Set(binding.keys) == ["session_id", "key_version", "created_at"],
              binding["session_id"] as? String == admission.session.uuidString.lowercased(),
              binding["key_version"] as? String == admission.keyVersion,
              let created = binding["created_at"] as? String, desktopDate(created) != nil,
              let lease = receipt["lease"] as? [String: Any],
              Set(lease.keys) == ["protocol_version", "receipt_id", "lease_id", "session_id", "generation", "issued_at", "expires_at"],
              lease["protocol_version"] as? String == "1.0",
              lease["session_id"] as? String == admission.session.uuidString.lowercased(),
              desktopInteger(lease["generation"], minimum: 1), (lease["generation"] as? NSNumber)?.intValue == 1,
              let leaseID = canonicalUUID(lease["lease_id"] as? String),
              let receiptID = canonicalUUID(lease["receipt_id"] as? String),
              let issued = lease["issued_at"] as? String, let issuedAt = desktopDate(issued),
              let expires = lease["expires_at"] as? String, let expiresAt = desktopDate(expires), expiresAt > issuedAt,
              let batch = receipt["reservations"] as? [String: Any],
              Set(batch.keys) == ["protocol_version", "batch_id", "session_id", "capture_authorized_until", "reservations"],
              batch["protocol_version"] as? String == "1.0", canonicalUUID(batch["batch_id"] as? String) != nil,
              batch["session_id"] as? String == admission.session.uuidString.lowercased(),
              batch["capture_authorized_until"] as? String == expires,
              let rows = batch["reservations"] as? [[String: Any]], rows.count == 30,
              let admissionRow = try? JSONSerialization.jsonObject(with: admission.receipt) as? [String: Any],
              let consent = admissionRow["consent_record_id"] as? String, canonicalUUID(consent) != nil else { return nil }
        var objects: Set<UUID> = []
        var tenant: UUID?
        for (index, row) in rows.enumerated() {
            guard Set(row.keys) == ["protocol_version", "object_id", "session_id", "channel", "sequence_number", "additional_authenticated_data", "created_at"],
                  row["protocol_version"] as? String == "1.0", row["channel"] as? String == "mixed",
                  row["session_id"] as? String == admission.session.uuidString.lowercased(),
                  desktopInteger(row["sequence_number"], minimum: 0), (row["sequence_number"] as? NSNumber)?.intValue == index,
                  let object = canonicalUUID(row["object_id"] as? String), objects.insert(object).inserted,
                  let aad = row["additional_authenticated_data"] as? String, aad.utf8.count <= 4096,
                  aad.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
                  let data = Data(base64Encoded: aad.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
                      + String(repeating: "=", count: (4 - aad.utf8.count % 4) % 4)),
                  let associated = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(associated.keys) == ["tenant_id", "session_id", "object_id", "channel", "sequence_number"],
                  let rowTenant = canonicalUUID(associated["tenant_id"] as? String), tenant == nil || tenant == rowTenant,
                  associated["session_id"] as? String == admission.session.uuidString.lowercased(),
                  associated["object_id"] as? String == object.uuidString.lowercased(), associated["channel"] as? String == "mixed",
                  desktopInteger(associated["sequence_number"], minimum: 0), (associated["sequence_number"] as? NSNumber)?.intValue == index,
                  let created = row["created_at"] as? String, desktopDate(created) != nil else { return nil }
            tenant = rowTenant
        }
        guard let preparation = try? NativeSourcePreparation(workspaceID: admission.mount.workspaceID,
            bindingRef: admission.mount.bindingRef, sessionID: admission.session, leaseID: leaseID,
            leaseReceiptID: receiptID, leaseGeneration: 1, captureAuthorizedUntil: expires, source: .desktop) else { return nil }
        return DesktopSourceStartTicket(scope: admission.sourceScope, preparation: preparation, consent: consent)
    }

    private static func isDesktopSourceStart(_ request: ProviderNativeRequest, ticket: DesktopSourceStartTicket) -> Bool {
        let preparation = ticket.preparation
        guard request.action == .sourceStartReady, canonicalUUID(request.key) != nil,
              let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "operation", "authorize_idempotency_key", "authorize_request_nonce"],
              body["workspace_id"] as? String == preparation.workspaceID.uuidString.lowercased(),
              body["binding_ref"] as? String == preparation.bindingRef,
              canonicalUUID(body["request_nonce"] as? String) != nil,
              let authorizeKey = body["authorize_idempotency_key"] as? String, canonicalUUID(authorizeKey) != nil,
              authorizeKey != request.key, canonicalUUID(body["authorize_request_nonce"] as? String) != nil,
              let operation = body["operation"] as? [String: Any], Set(operation.keys) == ["kind", "action", "payload"],
              operation["kind"] as? String == "source_start", operation["action"] as? String == "prepare",
              let payload = operation["payload"] as? [String: Any],
              Set(payload.keys) == ["schema_version", "attempt_id", "owner_proof", "source", "lease_id", "lease_receipt_id", "lease_generation", "capture_authorized_until"],
              payload["schema_version"] as? String == "1.0", canonicalUUID(payload["attempt_id"] as? String) != nil,
              let proof = payload["owner_proof"] as? String, proof.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              payload["source"] as? String == NativeSourcePreparation.Source.desktop.rawValue,
              payload["lease_id"] as? String == preparation.leaseID.uuidString.lowercased(),
              payload["lease_receipt_id"] as? String == preparation.leaseReceiptID.uuidString.lowercased(),
              desktopInteger(payload["lease_generation"], minimum: 1),
              (payload["lease_generation"] as? NSNumber)?.intValue == preparation.leaseGeneration,
              payload["capture_authorized_until"] as? String == preparation.captureAuthorizedUntil else { return false }
        return true
    }

    private static func desktopSourceConsentMatches(_ reply: ProviderNativeReply, ticket: DesktopSourceStartTicket) -> Bool {
        guard let pair = try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(pair.keys) == ["preparation", "authorization"],
              let prepared = pair["preparation"] as? [String: Any], let receipt = prepared["receipt"] as? [String: Any],
              let authorized = pair["authorization"] as? [String: Any], let decision = authorized["receipt"] as? [String: Any],
              let issued = decision["receipt"] as? [String: Any] else { return false }
        guard let consent = receipt["consent_record_id"] as? String, canonicalUUID(consent) != nil,
              ticket.consent == nil || consent == ticket.consent else { return false }
        return [receipt, issued].allSatisfy {
            $0["consent_record_id"] as? String == consent
                && $0["session_id"] as? String == ticket.preparation.sessionID.uuidString.lowercased()
        }
    }

    private func desktopUnusedContinuationTicket(_ request: ProviderNativeRequest, _ reply: ProviderNativeReply,
                                                 token: String, mintedAt: ContinuousClock.Instant,
                                                 mintedWall: Date?, epoch: UUID) -> DesktopSourceStartTicket? {
        // Separate from the admission shortcut: a first unused continuation
        // mints fresh authentication and receives a fresh generation-two lease.
        // Only its immediately following native-owned source decision may take
        // that JWT once. No saved admission, readiness or consent is reused.
        guard desktopInitialWindowEnabled, request.action == .operation, reply.status == 200,
              request.key.hasPrefix("continue-window:"),
              Self.canonicalUUID(String(request.key.dropFirst("continue-window:".count))) != nil,
              let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "operation"],
              let workspace = Self.canonicalUUID(body["workspace_id"] as? String),
              let mounted = recordingMounts[workspace], mounted.revision == request.revision,
              mounted.mount.desktopAdmissionMetadataSupported,
              body["binding_ref"] as? String == mounted.mount.bindingRef,
              Self.canonicalUUID(body["request_nonce"] as? String) != nil,
              let operation = body["operation"] as? [String: Any], Set(operation.keys) == ["kind", "payload"],
              operation["kind"] as? String == "prepare_continuation_window",
              let payload = operation["payload"] as? [String: Any],
              Set(payload.keys) == ["schema_version", "channel", "first_sequence_number", "previous_lease_id", "previous_lease_generation", "renew_idempotency_key", "reservation_idempotency_key"],
              payload["schema_version"] as? String == "1.0",
              let channel = payload["channel"] as? String, ["mixed", "microphone"].contains(channel),
              Self.desktopInteger(payload["first_sequence_number"], minimum: 0),
              (payload["first_sequence_number"] as? NSNumber)?.intValue == 0,
              Self.desktopInteger(payload["previous_lease_generation"], minimum: 1),
              (payload["previous_lease_generation"] as? NSNumber)?.intValue == 1,
              let previousLease = Self.canonicalUUID(payload["previous_lease_id"] as? String),
              let renew = payload["renew_idempotency_key"] as? String,
              let reserve = payload["reservation_idempotency_key"] as? String,
              renew.hasPrefix("renew:"), Self.canonicalUUID(String(renew.dropFirst(6))) != nil,
              reserve.hasPrefix("reserve:"), Self.canonicalUUID(String(reserve.dropFirst(8))) != nil,
              Set([request.key, renew, reserve]).count == 3,
              reply.body.count <= 131072,
              let value = try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(value.keys) == ["contract_version", "workspace_id", "binding_ref", "request_nonce", "checked_at", "operation", "receipt"],
              value["contract_version"] as? String == "1", value["workspace_id"] as? String == body["workspace_id"] as? String,
              value["binding_ref"] as? String == mounted.mount.bindingRef,
              value["request_nonce"] as? String == body["request_nonce"] as? String,
              value["operation"] as? String == "prepare_continuation_window",
              let checked = value["checked_at"] as? String, let checkedAt = Self.recentRecordingCheck(checked),
              let receipt = value["receipt"] as? [String: Any], Set(receipt.keys) == ["schema_version", "lease", "reservations"],
              receipt["schema_version"] as? String == "1.0",
              let lease = receipt["lease"] as? [String: Any],
              Set(lease.keys) == ["protocol_version", "receipt_id", "lease_id", "session_id", "generation", "issued_at", "expires_at"],
              lease["protocol_version"] as? String == "1.0",
              Self.canonicalUUID(lease["lease_id"] as? String) == previousLease,
              let session = Self.canonicalUUID(lease["session_id"] as? String),
              let receiptID = Self.canonicalUUID(lease["receipt_id"] as? String),
              Self.desktopInteger(lease["generation"], minimum: 1), (lease["generation"] as? NSNumber)?.intValue == 2,
              let issued = lease["issued_at"] as? String, let issuedAt = Self.desktopDate(issued),
              let expires = lease["expires_at"] as? String, let expiresAt = Self.desktopDate(expires), expiresAt > issuedAt,
              let batch = receipt["reservations"] as? [String: Any],
              Set(batch.keys) == ["protocol_version", "batch_id", "session_id", "capture_authorized_until", "reservations"],
              batch["protocol_version"] as? String == "1.0", Self.canonicalUUID(batch["batch_id"] as? String) != nil,
              batch["session_id"] as? String == session.uuidString.lowercased(), batch["capture_authorized_until"] as? String == expires,
              let rows = batch["reservations"] as? [[String: Any]], rows.count == 90 else { return nil }
        var objects: Set<UUID> = []
        var tenant: UUID?
        for (index, row) in rows.enumerated() {
            guard Set(row.keys) == ["protocol_version", "object_id", "session_id", "channel", "sequence_number", "additional_authenticated_data", "created_at"],
                  row["protocol_version"] as? String == "1.0", row["channel"] as? String == channel,
                  row["session_id"] as? String == session.uuidString.lowercased(),
                  Self.desktopInteger(row["sequence_number"], minimum: 0), (row["sequence_number"] as? NSNumber)?.intValue == index,
                  let object = Self.canonicalUUID(row["object_id"] as? String), objects.insert(object).inserted,
                  let aad = row["additional_authenticated_data"] as? String, aad.utf8.count <= 4096,
                  aad.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
                  let data = Data(base64Encoded: aad.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
                    + String(repeating: "=", count: (4 - aad.utf8.count % 4) % 4)),
                  let associated = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(associated.keys) == ["tenant_id", "session_id", "object_id", "channel", "sequence_number"],
                  let rowTenant = Self.canonicalUUID(associated["tenant_id"] as? String), tenant == nil || tenant == rowTenant,
                  associated["session_id"] as? String == session.uuidString.lowercased(),
                  associated["object_id"] as? String == object.uuidString.lowercased(), associated["channel"] as? String == channel,
                  Self.desktopInteger(associated["sequence_number"], minimum: 0), (associated["sequence_number"] as? NSNumber)?.intValue == index,
                  let created = row["created_at"] as? String, Self.desktopDate(created) != nil else { return nil }
            tenant = rowTenant
        }
        guard epoch == desktopInitialWindowEpoch, let mintedWall, let identity = auth.state().identity,
              let jwtExpiry = try? auth.validateInitialWindowToken(token, expectedRevision: request.revision),
              let account = try? auth.recordingAccountDigest(expectedRevision: request.revision),
              let preparation = try? NativeSourcePreparation(workspaceID: workspace, bindingRef: mounted.mount.bindingRef,
                sessionID: session, leaseID: previousLease, leaseReceiptID: receiptID, leaseGeneration: 2,
                captureAuthorizedUntil: expires, source: .desktop) else { return nil }
        let now = contextNow(), wall = desktopWallNow()
        guard Self.desktopClocksAgree(from: mintedAt, wall: mintedWall, to: now, wall: wall) else { return nil }
        let deadline = min(mintedAt.advanced(by: .seconds(5)),
            mintedAt.advanced(by: .seconds(jwtExpiry.timeIntervalSince(mintedWall))),
            now.advanced(by: .seconds(jwtExpiry.timeIntervalSince(wall))),
            now.advanced(by: .seconds(checkedAt.addingTimeInterval(30).timeIntervalSince(wall))))
        guard now < deadline else { return nil }
        return DesktopSourceStartTicket(scope: DesktopSourceScope(token: token, identity: identity,
            revision: request.revision, account: account, mount: mounted.mount, epoch: epoch,
            mintedAt: mintedAt, expires: deadline, clockAt: now, clockWall: wall), preparation: preparation, consent: nil)
    }

    private static func desktopCanonical(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private static func desktopDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private static func desktopClocksAgree(from: ContinuousClock.Instant, wall first: Date,
                                          to: ContinuousClock.Instant, wall last: Date) -> Bool {
        let duration = from.duration(to: to).components
        let elapsed = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
        let wallElapsed = last.timeIntervalSince(first)
        // Sampling skew is bounded to 1 ms; neither sample may run backwards.
        return elapsed.isFinite && wallElapsed.isFinite && elapsed >= 0 && wallElapsed >= 0
            && abs(elapsed - wallElapsed) < 0.001
    }

    private static func desktopInteger(_ value: Any?, minimum: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let value = number.doubleValue
        return value.isFinite && value.rounded(.down) == value && value >= Double(minimum)
            && value <= 9_007_199_254_740_991
    }

    private static func desktopCapabilities(_ value: Any?) -> Bool {
        guard let value = value as? [String: Any],
              Set(value.keys) == ["protocol_version", "media", "target_chunk_duration_ms", "max_envelope_bytes", "max_chunks",
                  "remaining_aggregate_plaintext_bytes", "capture_lease_ttl_seconds", "reservation_window_seconds",
                  "max_reservations_per_batch", "upload_concurrency"], value["protocol_version"] as? String == "1.0",
              let media = value["media"] as? [String: Any],
              Set(media.keys) == ["media_type", "encoding", "channels", "sample_rate_hz"],
              media["media_type"] as? String == "audio/wav", media["encoding"] as? String == "pcm_s16le",
              desktopInteger(media["channels"], minimum: 1), (media["channels"] as? NSNumber)?.intValue == 1,
              desktopInteger(media["sample_rate_hz"], minimum: 1), (media["sample_rate_hz"] as? NSNumber)?.intValue == 16000
        else { return false }
        return ["target_chunk_duration_ms", "max_envelope_bytes", "max_chunks", "capture_lease_ttl_seconds",
                "reservation_window_seconds", "max_reservations_per_batch", "upload_concurrency"].allSatisfy {
            desktopInteger(value[$0], minimum: 1)
        } && desktopInteger(value["remaining_aggregate_plaintext_bytes"], minimum: 0)
    }

    private func takeDesktopAdmissionReply(_ request: ProviderNativeRequest, _ reply: ProviderNativeReply,
                                          token: String, mintedAt: ContinuousClock.Instant,
                                          mintedWall: Date?, epoch: UUID) throws {
        guard desktopInitialWindowEnabled, request.action == .admission,
              let body = try JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let optIn = body["preparation_metadata"] as? NSNumber,
              CFGetTypeID(optIn) == CFBooleanGetTypeID(), optIn.boolValue else { return }
        guard Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "attestation", "configured_capture", "preparation_metadata"],
              body["attestation"] is [String: Any], let workspace = Self.canonicalUUID(body["workspace_id"] as? String),
              let binding = body["binding_ref"] as? String, let nonce = body["request_nonce"] as? String,
              Self.canonicalUUID(nonce) != nil, let mounted = recordingMounts[workspace], mounted.revision == request.revision,
              mounted.mount.bindingRef == binding, mounted.mount.desktopAdmissionMetadataSupported,
              reply.body.count <= 8192,
              let value = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              value["contract_version"] as? String == "1", value["workspace_id"] as? String == workspace.uuidString.lowercased(),
              value["binding_ref"] as? String == binding, value["request_nonce"] as? String == nonce,
              value["appointment_ref"] as? String == mounted.mount.appointmentRef,
              let operation = value["operation_ref"] as? String,
              operation.range(of: "^scribe_admission_[0-7][0-9a-hjkmnp-tv-z]{25}$", options: .regularExpression) != nil,
              Self.canonicalUUID(value["consent_record_id"] as? String) != nil,
              let session = Self.canonicalUUID(value["session_id"] as? String),
              let checked = value["checked_at"] as? String, let checkedAt = Self.recentRecordingCheck(checked),
              let metadata = value["preparation_metadata"] as? [String: Any],
              Set(metadata.keys) == ["schema_version", "review", "encryption_key", "capabilities"],
              metadata["schema_version"] as? String == "1.0", Self.desktopCapabilities(metadata["capabilities"]),
              let key = metadata["encryption_key"] as? [String: Any],
              let review = metadata["review"] as? [String: Any],
              review["schema_version"] as? String == "1.0", review["session_id"] as? String == session.uuidString.lowercased()
        else { throw ProviderNativeError.response }
        let publicKey = try NativeProviderRecordingPublicKey.parse(key)
        // The baseline admission does not require the optional status/configuration
        // extension. Keep its mandatory scope/nonce/metadata validation above;
        // an older or partial extension declines reuse without rejecting admission.
        guard Set(value.keys) == ["contract_version", "workspace_id", "binding_ref", "request_nonce", "checked_at",
                  "appointment_ref", "operation_ref", "consent_record_id", "session_id", "status", "configured_capture", "preparation_metadata"],
              value["status"] as? String == "admitted",
              let requested = body["configured_capture"] as? NSDictionary,
              value["configured_capture"] as? NSDictionary == requested else { return }
        // Existing/resumed review contents remain ordinary fresh work. The
        // shortcut parser accepts only the closed empty created review form.
        guard Set(review.keys) == ["schema_version", "session_id", "status", "source", "working", "review_queue", "translation_progress"],
              review["status"] as? String == "created", review["source"] is NSNull,
              review["working"] is NSNull, review["review_queue"] is NSNull,
              let progress = review["translation_progress"] as? [Any], progress.isEmpty,
              epoch == desktopInitialWindowEpoch, let mintedWall,
              let identity = auth.state().identity,
              let jwtExpiry = try? auth.validateInitialWindowToken(token, expectedRevision: request.revision)
        else { return }
        let now = contextNow(), wall = desktopWallNow()
        guard Self.desktopClocksAgree(from: mintedAt, wall: mintedWall, to: now, wall: wall) else { return }
        // Both original anchors are conservative: a wall adjustment cannot move
        // either original checked_at or JWT deadline later. Transfer never resets them.
        let expires = min(mintedAt.advanced(by: .seconds(5)),
            mintedAt.advanced(by: .seconds(checkedAt.addingTimeInterval(30).timeIntervalSince(mintedWall))),
            now.advanced(by: .seconds(checkedAt.addingTimeInterval(30).timeIntervalSince(wall))),
            mintedAt.advanced(by: .seconds(jwtExpiry.timeIntervalSince(mintedWall))),
            now.advanced(by: .seconds(jwtExpiry.timeIntervalSince(wall))))
        guard now < expires else { return }
        desktopInitialWindowTicket = DesktopInitialWindowTicket(token: token, identity: identity,
            revision: request.revision, account: try auth.recordingAccountDigest(expectedRevision: request.revision),
            admissionKey: request.key, admissionNonce: nonce, receipt: try Self.desktopCanonical(value),
            session: session, keyVersion: publicKey.version, mount: mounted.mount, epoch: epoch,
            mintedAt: mintedAt, expires: expires, clockAt: now, clockWall: wall)
        desktopInitialWindowExpiry = Task { @MainActor [weak self] in
            try? await Task.sleep(until: expires, clock: ContinuousClock())
            guard !Task.isCancelled, self?.desktopInitialWindowTicket?.epoch == epoch else { return }
            self?.desktopInitialWindowTicket = nil; self?.desktopInitialWindowExpiry = nil
            // An already claimed request keeps its publication epoch: expiration
            // limits dispatch and erases unused RAM, not an in-flight reply.
        }
    }

    private static func isDesktopInitialWindow(_ request: ProviderNativeRequest, ticket: DesktopInitialWindowTicket) -> Bool {
        func component(_ value: Any?, prefix: String) -> String? {
            guard let value = value as? String, value.hasPrefix(prefix + ":"),
                  canonicalUUID(String(value.dropFirst(prefix.count + 1))) != nil else { return nil }
            return value
        }
        guard request.action == .operation, component(request.key, prefix: "prepare-window") != nil,
              let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "operation"],
              body["workspace_id"] as? String == ticket.mount.workspaceID.uuidString.lowercased(),
              body["binding_ref"] as? String == ticket.mount.bindingRef, canonicalUUID(body["request_nonce"] as? String) != nil,
              let operation = body["operation"] as? [String: Any], Set(operation.keys) == ["kind", "payload"],
              operation["kind"] as? String == "prepare_recording_window",
              let payload = operation["payload"] as? [String: Any],
              Set(payload.keys) == ["schema_version", "binding", "bind_idempotency_key", "lease_idempotency_key", "reserve_idempotency_key", "channel", "reservation_count"],
              payload["schema_version"] as? String == "1.0", payload["channel"] as? String == "mixed",
              desktopInteger(payload["reservation_count"], minimum: 30), (payload["reservation_count"] as? NSNumber)?.intValue == 30,
              let binding = payload["binding"] as? [String: Any], Set(binding.keys) == ["key_version", "wrapped_dek"],
              binding["key_version"] as? String == ticket.keyVersion,
              let wrapped = binding["wrapped_dek"] as? String,
              wrapped.range(of: "^[A-Za-z0-9_-]{512}$", options: .regularExpression) != nil,
              let bind = component(payload["bind_idempotency_key"], prefix: "bind-key"),
              let lease = component(payload["lease_idempotency_key"], prefix: "lease"),
              let reserve = component(payload["reserve_idempotency_key"], prefix: "reserve") else { return false }
        return Set([request.key, bind, lease, reserve, ticket.admissionKey]).count == 5
    }

    /// No renderer route calls this method. The unconstructable native proof
    /// comes from new empty flow/window journals and successful new key custody.
    func sendFreshInitialWindow(_ request: ProviderNativeRequest, context: NativeProviderRecordingContext,
                                window: NativeRecordingWindowRequest,
                                proof: NativeRecordingFreshInitialWindow) async throws -> ProviderNativeReply {
        let saved = initialWindowTicket
        initialWindowExpiry?.cancel(); initialWindowExpiry = nil
        initialWindowTicket = nil // Claim before validation or any await; never restore.
        let scope = try NativeRecordingScope(tenantID: context.tenantID, sessionID: context.sessionID,
            workspaceID: context.workspaceID, accountDigest: context.accountDigest)
        var retainedTicket: InitialWindowTicket?
        if let saved, proof.matches(scope: scope, request: window, recoveryScope: saved.recovery),
           saved.revision == request.revision, saved.generation == recordingGeneration,
           saved.epoch == initialWindowEpoch,
           saved.account == context.accountDigest, saved.binding == context.bindingRef,
           saved.workspace == context.workspaceID, saved.session == context.sessionID,
           saved.tenant == context.tenantID,
           recordingMounts[context.workspaceID]?.mount.recoveryScope == saved.recovery,
           saved.identity == auth.state().identity,
           saved.admissionKey != request.key,
           contextNow() >= saved.mintedAt, contextNow() < saved.expires,
           try recordingPreparationKeyIsCurrent(context),
           Self.isInitialWindow(request, context: context, window: window),
           (try? auth.validateInitialWindowToken(saved.token, expectedRevision: request.revision)) != nil {
            retainedTicket = saved
        }
        return try await sendNative(request, initialWindowToken: retainedTicket)
    }

    private static func isInitialWindow(_ request: ProviderNativeRequest,
                                       context: NativeProviderRecordingContext,
                                       window: NativeRecordingWindowRequest) -> Bool {
        guard request.action == .operation,
              request.key == "native-initial-window-v1:" + window.bindIntent.uuidString.lowercased(),
              let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "operation"],
              body["workspace_id"] as? String == context.workspaceID.uuidString.lowercased(),
              body["binding_ref"] as? String == context.bindingRef,
              canonicalUUID(body["request_nonce"] as? String) != nil,
              let operation = body["operation"] as? [String: Any],
              Set(operation.keys) == ["kind", "payload"],
              operation["kind"] as? String == "prepare_recording_window",
              let payload = operation["payload"] as? NSDictionary else { return false }
        let expected: NSDictionary = ["schema_version": "1.0",
            "binding": ["key_version": window.keyVersion, "wrapped_dek": window.wrappedDEK],
            "bind_idempotency_key": window.bindIntent.uuidString.lowercased(),
            "lease_idempotency_key": window.leaseIntent.uuidString.lowercased(),
            "reserve_idempotency_key": window.reserveIntent.uuidString.lowercased(),
            "channel": "microphone", "reservation_count": 30]
        return window.count == 30 && Set([window.bindIntent, window.leaseIntent, window.reserveIntent]).count == 3
            && payload == expected
    }

    private func sendNative(_ request: ProviderNativeRequest,
                            initialWindowToken: InitialWindowTicket?,
                            desktopWindowToken: DesktopInitialWindowTicket? = nil,
                            desktopSourceToken: DesktopSourceStartTicket? = nil) async throws -> ProviderNativeReply {
        guard request.action != .recorderContext else { throw ProviderNativeError.invalidRequest }
        guard !closed, pending[request.id] == nil, pending.count < 8 else {
            throw ProviderNativeError.unavailable
        }
        guard earlyCancellations.remove(request.id) == nil else { throw ProviderNativeError.cancelled }
        try current(request.revision)
        let visitSignIn = claimVisitSignIn(request)
        let request = try admissionPreparationRequest(request)
        var succeeded = false
        defer {
            if preparingAdmission == request.id { preparingAdmission = nil }
            if !succeeded, preparedAdmission?.requestID == request.id { preparedAdmission = nil }
        }
        // A replacement mount that is cancelled, rejected or malformed cannot
        // leave an older namespace available for a new native recording.
        if request.action == .mount,
           let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
           let workspace = body["workspace_id"] as? String, let id = UUID(uuidString: workspace) {
            recordingMounts.removeValue(forKey: id)
            preparingAdmission = nil
            preparedAdmission = nil
            preparedRecording = nil; recordingGeneration = UUID()
        }
        let desktopEpoch = desktopInitialWindowEpoch
        var sourceCandidate: DesktopSourceStartTicket?
        let operation = Task { @MainActor [auth, wire, timingNow, requestTiming] in
            let started = timingNow()
            let requestInterval = ProviderNativeRequestTiming.begin("Provider request")
            var tokenInterval: OSSignpostIntervalState? = ProviderNativeRequestTiming.begin("Provider token")
            var receiverInterval: OSSignpostIntervalState?
            var tokenEnd: ContinuousClock.Instant?, receiverStart: ContinuousClock.Instant?
            var receiverEnd: ContinuousClock.Instant?, status: Int?
            var completed = false
            var serverTiming: ProviderServerTiming?
            var coreTiming: ProviderCoreTiming?
            defer {
                if let tokenInterval { ProviderNativeRequestTiming.end("Provider token", tokenInterval) }
                if let receiverInterval { ProviderNativeRequestTiming.end("Provider receiver", receiverInterval) }
                ProviderNativeRequestTiming.end("Provider request", requestInterval)
                let ended = timingNow()
                requestTiming(ProviderNativeRequestTiming(action: request.action,
                    tokenMilliseconds: ProviderNativeRequestTiming.milliseconds(from: started, to: tokenEnd ?? ended),
                    receiverMilliseconds: receiverStart.map {
                        ProviderNativeRequestTiming.milliseconds(from: $0, to: receiverEnd ?? ended)
                    }, totalMilliseconds: ProviderNativeRequestTiming.milliseconds(from: started, to: ended),
                    status: status, completed: completed, serverTiming: serverTiming, coreTiming: coreTiming))
            }
            try Task.checkCancellation()
            var token: String
            let usedWindowTicket: InitialWindowTicket?
            var usedDesktopWindowTicket: DesktopInitialWindowTicket?
            var usedDesktopSourceTicket: DesktopSourceStartTicket?
            var usedVisitSignIn: VisitSignInTicket?
            if let initialWindowToken,
               self.contextNow() >= initialWindowToken.mintedAt,
               self.contextNow() < initialWindowToken.expires,
               self.initialWindowEpoch == initialWindowToken.epoch,
               self.recordingGeneration == initialWindowToken.generation,
               auth.state().identity == initialWindowToken.identity,
               (try? auth.validateInitialWindowToken(initialWindowToken.token, expectedRevision: request.revision)) != nil {
                token = initialWindowToken.token; usedWindowTicket = initialWindowToken
                usedDesktopWindowTicket = nil
            } else if let desktopWindowToken,
                      self.desktopTicketIsCurrent(desktopWindowToken, revision: request.revision),
                      Self.isDesktopInitialWindow(request, ticket: desktopWindowToken) {
                token = desktopWindowToken.token; usedDesktopWindowTicket = desktopWindowToken
                usedWindowTicket = nil
            } else if let desktopSourceToken,
                      self.desktopTicketIsCurrent(desktopSourceToken.scope, revision: request.revision),
                      Self.isDesktopSourceStart(request, ticket: desktopSourceToken) {
                token = desktopSourceToken.scope.token; usedDesktopSourceTicket = desktopSourceToken
                usedDesktopWindowTicket = nil; usedWindowTicket = nil
            } else {
                // No wire I/O has occurred. An optional ticket that expired while
                // this Task was scheduled behaves exactly like a ticket miss.
                usedWindowTicket = nil
                usedDesktopWindowTicket = nil
                let prepared = await withTaskCancellationHandler {
                    await visitSignIn?.value
                } onCancel: {
                    visitSignIn?.cancel()
                }
                try Task.checkCancellation(); try self.current(request.revision)
                if let prepared,
                   self.visitSignInIsCurrent(prepared, revision: request.revision),
                   self.contextNow() < prepared.mintedAt.advanced(by: .seconds(1)) {
                    // Leave at least four of the original five seconds for the
                    // measured Core/window/source chain. Older idle tokens use
                    // the ordinary fresh path rather than causing extra mints later.
                    token = prepared.token; usedVisitSignIn = prepared
                } else {
                    token = try await auth.token(expectedRevision: request.revision,
                                                nativeSessionWithoutOrigin: true)
                }
            }
            var mintedAt = usedVisitSignIn?.mintedAt ?? self.contextNow()
            var desktopMintedWall = usedVisitSignIn?.mintedWall ?? (self.desktopInitialWindowEnabled ? self.desktopWallNow() : nil)
            tokenEnd = timingNow()
            if let interval = tokenInterval { ProviderNativeRequestTiming.end("Provider token", interval) }
            tokenInterval = nil
            try self.current(request.revision)
            try Task.checkCancellation()
            if let prepared = usedVisitSignIn,
               (!self.visitSignInIsCurrent(prepared, revision: request.revision)
                || self.contextNow() >= prepared.mintedAt.advanced(by: .seconds(1))) {
                // Still before dispatch: use the ordinary fresh path once.
                usedVisitSignIn = nil
                token = try await auth.token(expectedRevision: request.revision, nativeSessionWithoutOrigin: true)
                mintedAt = self.contextNow(); desktopMintedWall = self.desktopWallNow()
                tokenEnd = timingNow()
                try self.current(request.revision); try Task.checkCancellation()
            }
            if let desktop = usedDesktopWindowTicket?.sourceScope ?? usedDesktopSourceTicket?.scope,
               !self.desktopTicketIsCurrent(desktop, revision: request.revision) {
                // Still before wire: scheduling/local recovery consumed the
                // original deadline. One fresh mint, with no repeated dispatch.
                usedDesktopWindowTicket = nil
                usedDesktopSourceTicket = nil
                tokenEnd = nil
                tokenInterval = ProviderNativeRequestTiming.begin("Provider token")
                token = try await auth.token(expectedRevision: request.revision, nativeSessionWithoutOrigin: true)
                tokenEnd = timingNow()
                if let interval = tokenInterval { ProviderNativeRequestTiming.end("Provider token", interval) }
                tokenInterval = nil
                try self.current(request.revision); try Task.checkCancellation()
            }
            receiverStart = timingNow()
            receiverInterval = ProviderNativeRequestTiming.begin("Provider receiver")
            let reply = try await wire.send(request, token: token)
            receiverEnd = timingNow(); status = reply.status; serverTiming = reply.serverTiming
            coreTiming = reply.coreTiming
            if let interval = receiverInterval { ProviderNativeRequestTiming.end("Provider receiver", interval) }
            receiverInterval = nil
            try Task.checkCancellation()
            try self.current(request.revision)
            if let prepared = usedVisitSignIn {
                // Expiry bounds dispatch only. Account/mount/epoch publication
                // fences remain after possibly committed I/O; never retry it.
                guard self.visitSignInEpoch == prepared.epoch,
                      self.auth.state().identity == prepared.identity,
                      (try? self.auth.recordingAccountDigest(expectedRevision: request.revision)) == prepared.account,
                      self.recordingMounts[prepared.mount.workspaceID]?.mount == prepared.mount
                else { throw ProviderNativeError.cancelled }
            }
            if let initialWindowToken = usedWindowTicket {
                // Five seconds bounds the single dispatch, not the response
                // lifetime. Preserve the existing in-flight publication fences.
                guard self.initialWindowEpoch == initialWindowToken.epoch,
                      self.recordingGeneration == initialWindowToken.generation,
                      auth.state().identity == initialWindowToken.identity
                else { throw ProviderNativeError.cancelled }
            }
            if let desktop = usedDesktopWindowTicket {
                // Expiry limits dispatch, not the response. Account/mount/epoch
                // publication fences remain mandatory after I/O and cancellation.
                guard self.desktopInitialWindowEpoch == desktop.epoch,
                      auth.state().identity == desktop.identity,
                      (try? auth.recordingAccountDigest(expectedRevision: request.revision)) == desktop.account,
                      self.recordingMounts[desktop.mount.workspaceID]?.revision == request.revision,
                      self.recordingMounts[desktop.mount.workspaceID]?.mount == desktop.mount else {
                    throw ProviderNativeError.cancelled
                }
                if reply.status == 200 {
                    guard let value = try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
                          let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                          Set(value.keys) == ["contract_version", "workspace_id", "binding_ref", "request_nonce", "checked_at", "operation", "receipt"],
                          value["contract_version"] as? String == "1",
                          value["workspace_id"] as? String == desktop.mount.workspaceID.uuidString.lowercased(),
                          value["binding_ref"] as? String == desktop.mount.bindingRef,
                          value["request_nonce"] as? String == body["request_nonce"] as? String,
                          value["operation"] as? String == "prepare_recording_window",
                          value["checked_at"] is String, value["receipt"] is [String: Any] else {
                        throw ProviderNativeError.response
                    }
                }
            }
            if let source = usedDesktopSourceTicket {
                guard self.desktopPublicationIsCurrent(source.scope, revision: request.revision) else {
                    throw ProviderNativeError.cancelled
                }
                // Core still authenticates and authorizes this request. Preserve
                // NativeSourceStartOwner's full decision checks and additionally
                // bind both returned decisions to this admission's consent.
                if reply.status == 200,
                   (reply.body.count > request.responseLimit || !Self.desktopSourceConsentMatches(reply, ticket: source)) {
                    throw ProviderNativeError.response
                }
            }
            guard request.action.acceptsResponseStatus(reply.status),
                  reply.body.count <= request.responseLimit else {
                throw ProviderNativeError.response
            }
            if reply.status != 200 {
                self.rememberRecordingMount(request, reply)
                // Do not forward arbitrary proxy/SDK/error content to JavaScript.
                completed = true
                return Self.sanitizedFailure(reply, action: request.action)
            }
            guard (try? JSONSerialization.jsonObject(with: reply.body)) is [String: Any] else {
                throw ProviderNativeError.response
            }
            self.rememberRecordingMount(request, reply)
            let published = try self.takeAdmissionPreparationReply(request, reply, token: token, mintedAt: mintedAt)
            try self.takeDesktopAdmissionReply(request, published, token: token, mintedAt: mintedAt,
                                               mintedWall: desktopMintedWall, epoch: desktopEpoch)
            if let desktop = usedDesktopWindowTicket {
                sourceCandidate = Self.desktopSourceTicket(published, admission: desktop)
            } else {
                sourceCandidate = self.desktopUnusedContinuationTicket(request, published, token: token,
                    mintedAt: mintedAt, mintedWall: desktopMintedWall, epoch: desktopEpoch)
            }
            completed = true
            return published
        }
        pending[request.id] = (request.revision, operation)
        defer { pending.removeValue(forKey: request.id) }
        let reply = try await withTaskCancellationHandler {
            let reply = try await operation.value
            try Task.checkCancellation()
            try current(request.revision)
            return reply
        } onCancel: {
            operation.cancel()
        }
        prepareVisitSignIn(after: request)
        // Publish only after the outer cancellation/current-revision check. A
        // late window reply cannot extend the admission deadline or refill RAM.
        if let sourceCandidate,
           desktopTicketIsCurrent(sourceCandidate.scope, revision: request.revision) {
            desktopSourceStartTicket = sourceCandidate
            let epoch = sourceCandidate.scope.epoch, expires = sourceCandidate.scope.expires
            desktopSourceStartExpiry = Task { @MainActor [weak self] in
                try? await Task.sleep(until: expires, clock: ContinuousClock())
                guard !Task.isCancelled, self?.desktopSourceStartTicket?.scope.epoch == epoch else { return }
                self?.desktopSourceStartTicket = nil; self?.desktopSourceStartExpiry = nil
                // Do not invalidate a source request already claimed/dispatched.
            }
        }
        succeeded = true
        return reply
    }

    static func sanitizedFailure(_ reply: ProviderNativeReply, action: ProviderNativeAction) -> ProviderNativeReply {
        if action == .admission, reply.status == 409, reply.body.count <= 1024,
           let value = try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
           Set(value.keys) == ["detail"], value["detail"] as? String == "core_provider_consent_required" {
            return ProviderNativeReply(status: 409,
                body: Data("{\"detail\":\"provider_consent_required\"}".utf8))
        }
        return ProviderNativeReply(status: reply.status,
            body: Data("{\"detail\":\"provider_request_unconfirmed\"}".utf8))
    }

    private func current(_ revision: String) throws {
        let state = auth.state()
        guard !closed, state.phase == .ready, state.revision == revision else {
            throw ProviderNativeError.unavailable
        }
    }
}
