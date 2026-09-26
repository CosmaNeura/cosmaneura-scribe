import Foundation
import CosmasNativeAuth

enum ProviderNativeError: String, Error, Sendable {
    case unavailable = "provider_native_unavailable"
    case invalidRequest = "provider_native_request_invalid"
    case cancelled = "provider_native_cancelled"
    case response = "provider_native_response_invalid"
    case authorityChanged = "provider_native_authority_changed"
}

enum ProviderNativeAction: String, Sendable {
    case catalog, mount, recorder
    case sourceStart = "source-start"
    case admission = "capture-admissions", operation = "capture-operations", note = "capture-notes"

    var bodyLimit: Int {
        switch self {
        case .catalog: 2
        case .mount: 256
        case .recorder: 1024
        case .sourceStart: 4096
        case .admission: 2048
        case .operation: 4_194_304
        case .note: 262_144 + 8192
        }
    }
    var responseLimit: Int {
        switch self {
        case .catalog: 65_536
        case .mount, .recorder, .sourceStart: 8192
        case .operation: 32 * 1024 * 1024 + 8192
        case .admission, .note: 8 * 1024 * 1024
        }
    }
}

struct ProviderNativeRequest: Sendable {
    let id: UUID
    let revision: String
    let action: ProviderNativeAction
    let key: String
    let body: Data

    init(id: String, revision: String, action: String, key: String, body: String) throws {
        guard let identifier = UUID(uuidString: id), identifier.uuidString.lowercased() == id,
              UUID(uuidString: revision)?.uuidString.lowercased() == revision,
              let operation = ProviderNativeAction(rawValue: action),
              operation != .sourceStart,
              key.range(of: "^[A-Za-z0-9._:-]{8,255}$", options: .regularExpression) != nil,
              body.utf8.count <= operation.bodyLimit, let data = body.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
        else { throw ProviderNativeError.invalidRequest }
        self.id = identifier; self.revision = revision; self.action = operation
        self.key = key; self.body = data
    }

    // Not reachable from the generic Capacitor/renderer string-action initializer.
    init(nativeStartID: UUID, revision: String, key: String, body: Data) throws {
        guard UUID(uuidString: revision)?.uuidString.lowercased() == revision,
              key.range(of: "^[A-Za-z0-9._:-]{8,255}$", options: .regularExpression) != nil,
              body.count <= ProviderNativeAction.sourceStart.bodyLimit,
              (try? JSONSerialization.jsonObject(with: body)) is [String: Any]
        else { throw ProviderNativeError.invalidRequest }
        self.id = nativeStartID; self.revision = revision; self.action = .sourceStart
        self.key = key; self.body = body
    }
}

struct ProviderNativeReply: Sendable {
    let status: Int
    let body: Data
}

/// Minted only by a current Core response. This identifies key custody; the
/// source-start gate still independently decides whether capture may begin.
struct NativeProviderRecordingContext: Equatable, Sendable {
    let bindingRef: String
    let workspaceID: UUID
    let tenantID: UUID
    let sessionID: UUID
    let accountDigest: String
    fileprivate init(bindingRef: String, workspaceID: UUID, tenantID: UUID, sessionID: UUID, accountDigest: String) {
        self.bindingRef = bindingRef
        self.workspaceID = workspaceID; self.tenantID = tenantID
        self.sessionID = sessionID; self.accountDigest = accountDigest
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

    init(auth: NativeWorkspaceAuth, wire: any ProviderNativeWire) {
        self.auth = auth; self.wire = wire
    }

    func authChanged(_ state: NativeAuthState) {
        recordingMounts = recordingMounts.filter { state.phase == .ready && $0.value.revision == state.revision }
        for (_, operation) in pending where state.phase != .ready || operation.revision != state.revision {
            operation.task.cancel()
        }
    }

    func cancel(_ id: UUID) {
        if let operation = pending[id] { operation.task.cancel(); return }
        // Capacitor promise calls can be cancelled before their MainActor task
        // enters send(). Keep that cancellation, never dispatch it afterward.
        guard earlyCancellations.count < 1024 else { close(); return }
        earlyCancellations.insert(id)
    }

    func close() {
        closed = true
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
                          revision: String) async throws -> NativeProviderRecordingContext {
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
        let request = try ProviderNativeRequest(id: UUID().uuidString.lowercased(), revision: revision,
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
              let checked = value["checked_at"] as? String, Self.recentRecordingCheck(checked),
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
                                               sessionID: sessionID, accountDigest: account)
    }

    private static func recentRecordingCheck(_ value: String) -> Bool {
        guard value.utf8.count <= 40 else { return false }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var checked = parser.date(from: value)
        if checked == nil { parser.formatOptions = [.withInternetDateTime]; checked = parser.date(from: value) }
        guard let checked else { return false }
        let age = Date().timeIntervalSince(checked)
        return age >= -5 && age <= 30
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
        guard Set(body.keys) == ["workspace_id"], reply.status == 200, reply.body.count <= 8192,
              let value = try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(value.keys) == ["revision", "recoveryScope", "workspaceId", "appointmentRef", "bindingRef", "encounter"],
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
        recordingMounts[id] = (request.revision, NativeProviderRecordingMount(
            workspaceID: id, bindingRef: binding, recoveryScope: scope))
    }

    func send(_ request: ProviderNativeRequest) async throws -> ProviderNativeReply {
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
        }
        let operation = Task { @MainActor [auth, wire] in
            try Task.checkCancellation()
            let token = try await auth.token(expectedRevision: request.revision,
                                             nativeSessionWithoutOrigin: true)
            try self.current(request.revision)
            try Task.checkCancellation()
            let reply = try await wire.send(request, token: token)
            try Task.checkCancellation()
            try self.current(request.revision)
            guard [200, 401, 403, 409, 422, 503].contains(reply.status),
                  reply.body.count <= request.action.responseLimit else {
                throw ProviderNativeError.response
            }
            if reply.status != 200 {
                self.rememberRecordingMount(request, reply)
                // Do not forward arbitrary proxy/SDK/error content to JavaScript.
                return Self.sanitizedFailure(reply, action: request.action)
            }
            guard (try? JSONSerialization.jsonObject(with: reply.body)) is [String: Any] else {
                throw ProviderNativeError.response
            }
            self.rememberRecordingMount(request, reply)
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
