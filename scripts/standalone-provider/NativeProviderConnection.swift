import Foundation
import CosmasNativeAuth

enum ProviderNativeError: String, Error, Sendable {
    case unavailable = "provider_native_unavailable"
    case invalidRequest = "provider_native_request_invalid"
    case cancelled = "provider_native_cancelled"
    case response = "provider_native_response_invalid"
}

enum ProviderNativeAction: String, Sendable {
    case catalog, mount, recorder
    case admission = "capture-admissions", operation = "capture-operations", note = "capture-notes"

    var bodyLimit: Int {
        switch self {
        case .catalog: 2
        case .mount: 256
        case .recorder: 1024
        case .admission: 2048
        case .operation: 4_194_304
        case .note: 262_144 + 8192
        }
    }
    var responseLimit: Int {
        switch self {
        case .catalog: 65_536
        case .mount, .recorder: 8192
        case .admission, .operation, .note: 8 * 1024 * 1024
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
              key.range(of: "^[A-Za-z0-9._:-]{8,255}$", options: .regularExpression) != nil,
              body.utf8.count <= operation.bodyLimit, let data = body.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
        else { throw ProviderNativeError.invalidRequest }
        self.id = identifier; self.revision = revision; self.action = operation
        self.key = key; self.body = data
    }
}

struct ProviderNativeReply: Sendable {
    let status: Int
    let body: Data
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

    init(auth: NativeWorkspaceAuth, wire: any ProviderNativeWire) {
        self.auth = auth; self.wire = wire
    }

    func authChanged(_ state: NativeAuthState) {
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
        for (_, operation) in pending { operation.task.cancel() }
    }

    func send(_ request: ProviderNativeRequest) async throws -> ProviderNativeReply {
        guard !closed, pending[request.id] == nil, pending.count < 8 else {
            throw ProviderNativeError.unavailable
        }
        guard earlyCancellations.remove(request.id) == nil else { throw ProviderNativeError.cancelled }
        try current(request.revision)
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
                // Do not forward arbitrary proxy/SDK/error content to JavaScript.
                return ProviderNativeReply(status: reply.status,
                    body: Data("{\"detail\":\"provider_request_unconfirmed\"}".utf8))
            }
            guard (try? JSONSerialization.jsonObject(with: reply.body)) is [String: Any] else {
                throw ProviderNativeError.response
            }
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

    private func current(_ revision: String) throws {
        let state = auth.state()
        guard !closed, state.phase == .ready, state.revision == revision else {
            throw ProviderNativeError.unavailable
        }
    }
}
