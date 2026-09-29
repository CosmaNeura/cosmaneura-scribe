import Foundation
import OSLog
import CosmasNativeAuth

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
        case .encounters: 4096
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
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
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

struct ProviderNativeReply: Sendable {
    let status: Int
    let body: Data
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

    private static let logger = Logger(subsystem: "com.cosmaneura.scribe.performance", category: "provider")

    func log() {
        Self.logger.info("provider_request action=\(action.rawValue, privacy: .public) token_ms=\(tokenMilliseconds) receiver_ms=\(receiverMilliseconds ?? -1) total_ms=\(totalMilliseconds) status=\(status ?? 0) completed=\(completed)")
    }

    static func milliseconds(from start: ContinuousClock.Instant, to end: ContinuousClock.Instant) -> Int {
        let parts = start.duration(to: end).components
        return max(0, Int((Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15).rounded()))
    }
}

/// Minted only by a current Core response. This identifies key custody; the
/// source-start gate still independently decides whether capture may begin.
struct NativeProviderRecordingContext: Equatable, Sendable {
    let bindingRef: String
    let workspaceID: UUID
    let tenantID: UUID
    let sessionID: UUID
    let accountDigest: String
    fileprivate let checkedAt: Date
    fileprivate init(bindingRef: String, workspaceID: UUID, tenantID: UUID, sessionID: UUID, accountDigest: String, checkedAt: Date) {
        self.bindingRef = bindingRef
        self.workspaceID = workspaceID; self.tenantID = tenantID
        self.sessionID = sessionID; self.accountDigest = accountDigest; self.checkedAt = checkedAt
    }
}

/// Namespace copied from a verified native Core mount response. Keeping only
/// these IDs avoids both a second mount request and renderer-chosen queue custody.
struct NativeProviderRecordingMount: Equatable, Sendable {
    let workspaceID: UUID
    let bindingRef: String
    let recoveryScope: UUID
    fileprivate init(workspaceID: UUID, bindingRef: String, recoveryScope: UUID) {
        self.workspaceID = workspaceID; self.bindingRef = bindingRef
        self.recoveryScope = recoveryScope
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
    private var pending: [UUID: (revision: String, task: Task<ProviderNativeReply, Error>)] = [:]
    private var earlyCancellations: Set<UUID> = []
    private var closed = false
    private var recordingMounts: [UUID: (revision: String, mount: NativeProviderRecordingMount)] = [:]

    private struct PreparedRecordingContext {
        let requestID: UUID, nonce: UUID, revision: String
        let mount: NativeProviderRecordingMount, context: NativeProviderRecordingContext
        let expires: ContinuousClock.Instant
    }
    private var preparedRecording: PreparedRecordingContext?
    private var preparingRecording: UUID?
    private var recordingGeneration = UUID()
    private let contextNow: @MainActor () -> ContinuousClock.Instant
    private let timingNow: @MainActor () -> ContinuousClock.Instant
    private let requestTiming: @MainActor (ProviderNativeRequestTiming) -> Void

    init(auth: NativeWorkspaceAuth, wire: any ProviderNativeWire,
         contextNow: @escaping @MainActor () -> ContinuousClock.Instant = { .now },
         timingNow: @escaping @MainActor () -> ContinuousClock.Instant = { .now },
         requestTiming: @escaping @MainActor (ProviderNativeRequestTiming) -> Void = { $0.log() }) {
        self.auth = auth; self.wire = wire; self.contextNow = contextNow
        self.timingNow = timingNow; self.requestTiming = requestTiming
    }

    func authChanged(_ state: NativeAuthState) {
        preparedRecording = nil; recordingGeneration = UUID()
        recordingMounts = recordingMounts.filter { state.phase == .ready && $0.value.revision == state.revision }
        for (_, operation) in pending where state.phase != .ready || operation.revision != state.revision {
            operation.task.cancel()
        }
    }

    func cancel(_ id: UUID) {
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
        closed = true
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
        let nonce = UUID().uuidString.lowercased()
        let body = try JSONSerialization.data(withJSONObject: [
            "workspace_id": workspaceID.uuidString.lowercased(), "binding_ref": bindingRef,
            "request_nonce": nonce, "operation": ["kind": "native_recording_context"],
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
              value["operation"] as? String == "native_recording_context",
              let checked = value["checked_at"] as? String, let checkedAt = Self.recentRecordingCheck(checked),
              let receipt = value["receipt"] as? [String: Any],
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
                                               sessionID: sessionID, accountDigest: account, checkedAt: checkedAt)
    }

    /// Reuse the same fresh Core check before renderer custody inspection and
    /// native open. Only an acknowledgement crosses the bridge, never the tenant.
    /// This single-use metadata does not grant microphone or source permission.
    func prepareRecordingContext(_ request: ProviderNativeRequest) async throws -> ProviderNativeReply {
        preparedRecording = nil
        let ticket = UUID(); recordingGeneration = ticket
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
        let context = try await recordingContext(workspaceID: workspace, bindingRef: binding,
            sessionID: session, revision: request.revision, requestID: request.id)
        try current(request.revision)
        guard ticket == recordingGeneration,
              try recordingMount(workspaceID: workspace, bindingRef: binding, revision: request.revision) == mount else {
            throw ProviderNativeError.authorityChanged
        }
        // Include the original server freshness bound and use monotonic elapsed
        // time, so clock changes cannot extend reuse. Expiry causes a fresh read.
        let remaining = max(0, min(5, 30 - Date().timeIntervalSince(context.checkedAt)))
        preparedRecording = PreparedRecordingContext(requestID: request.id, nonce: nonce,
            revision: request.revision, mount: mount, context: context,
            expires: contextNow().advanced(by: .seconds(remaining)))
        return ProviderNativeReply(status: 200, body: try JSONSerialization.data(withJSONObject: [
            "revision": request.revision, "session_id": session.uuidString.lowercased(),
            "authorization_id": nonce.uuidString.lowercased(),
        ]))
    }

    func takePreparedRecordingContext(nonce: UUID, workspaceID: UUID, bindingRef: String,
                                      sessionID: UUID, revision: String) throws -> NativeProviderRecordingContext? {
        let saved = preparedRecording
        preparedRecording = nil; recordingGeneration = UUID()
        try current(revision)
        guard let saved, saved.nonce == nonce, saved.revision == revision,
              saved.context.workspaceID == workspaceID, saved.context.bindingRef == bindingRef,
              saved.context.sessionID == sessionID,
              saved.context.accountDigest == (try auth.recordingAccountDigest(expectedRevision: revision)),
              try recordingMount(workspaceID: workspaceID, bindingRef: bindingRef, revision: revision) == saved.mount else {
            throw ProviderNativeError.authorityChanged
        }
        return contextNow() < saved.expires ? saved.context : nil
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
        recordingMounts[id] = (request.revision, NativeProviderRecordingMount(
            workspaceID: id, bindingRef: binding, recoveryScope: scope))
    }

    func send(_ request: ProviderNativeRequest) async throws -> ProviderNativeReply {
        guard request.action != .recorderContext else { throw ProviderNativeError.invalidRequest }
        guard !closed, pending[request.id] == nil, pending.count < 8 else {
            throw ProviderNativeError.unavailable
        }
        guard earlyCancellations.remove(request.id) == nil else { throw ProviderNativeError.cancelled }
        try current(request.revision)
        // A replacement mount that is cancelled, rejected or malformed cannot
        // leave an older namespace available for a new native recording.
        if request.action == .mount,
           let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
           let workspace = body["workspace_id"] as? String, let id = UUID(uuidString: workspace) {
            recordingMounts.removeValue(forKey: id)
            preparedRecording = nil; recordingGeneration = UUID()
        }
        let operation = Task { @MainActor [auth, wire, timingNow, requestTiming] in
            let started = timingNow()
            var tokenEnd: ContinuousClock.Instant?, receiverStart: ContinuousClock.Instant?
            var receiverEnd: ContinuousClock.Instant?, status: Int?
            var completed = false
            defer {
                let ended = timingNow()
                requestTiming(ProviderNativeRequestTiming(action: request.action,
                    tokenMilliseconds: ProviderNativeRequestTiming.milliseconds(from: started, to: tokenEnd ?? ended),
                    receiverMilliseconds: receiverStart.map {
                        ProviderNativeRequestTiming.milliseconds(from: $0, to: receiverEnd ?? ended)
                    }, totalMilliseconds: ProviderNativeRequestTiming.milliseconds(from: started, to: ended),
                    status: status, completed: completed))
            }
            try Task.checkCancellation()
            let token = try await auth.token(expectedRevision: request.revision,
                                             nativeSessionWithoutOrigin: true)
            tokenEnd = timingNow()
            try self.current(request.revision)
            try Task.checkCancellation()
            receiverStart = timingNow()
            let reply = try await wire.send(request, token: token)
            receiverEnd = timingNow(); status = reply.status
            try Task.checkCancellation()
            try self.current(request.revision)
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
            completed = true
            return reply
        }
        pending[request.id] = (request.revision, operation)
        defer { pending.removeValue(forKey: request.id) }
        return try await withTaskCancellationHandler {
            let reply = try await operation.value
            try Task.checkCancellation()
            try current(request.revision)
            return reply
        } onCancel: {
            operation.cancel()
        }
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
