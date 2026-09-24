import Foundation

public struct NativeCapturePermit: Sendable {
    public let runID: String
    public let startExpiresAt: Date
    public let captureExpiresAt: Date

    public init(runID: String, startExpiresAt: Date, captureExpiresAt: Date) throws {
        guard UUID(uuidString: runID)?.uuidString.lowercased() == runID,
              startExpiresAt > Date(), captureExpiresAt >= startExpiresAt else {
            throw NativeAuthError.unavailable
        }
        self.runID = runID; self.startExpiresAt = startExpiresAt
        self.captureExpiresAt = captureExpiresAt
    }
}

/// The standalone native microphone and authenticated provider bridge share this
/// in-process gate. JavaScript can neither install a handler nor supply a permit.
@MainActor public enum NativeCaptureStartGate {
    private static var owner: UUID?
    private static var authorize: (@MainActor () async throws -> NativeCapturePermit)?
    private static var idle: (@MainActor () -> Bool)?
    private static var retiring = false
    private static var authorizing = false
    private static var recovering = false

    /// Native PCM supplies the process-wide ownership check; no JS callback.
    public static func registerIdleProbe(_ probe: @escaping @MainActor () -> Bool) {
        idle = probe
    }

    public static func install(owner: UUID,
                               authorize: @escaping @MainActor () async throws -> NativeCapturePermit) throws {
        guard !recovering, self.owner == nil || (self.owner == owner && !retiring) else { throw NativeAuthError.busy }
        if self.owner == nil { retiring = false }
        self.owner = owner; self.authorize = authorize
    }

    public static func clear(owner: UUID) {
        if self.owner == owner { self.owner = nil; self.authorize = nil; retiring = true }
    }

    /// Keep the owner marker until physical closure is confirmed. An in-flight
    /// authorization cannot cross this fence, even after the same account returns.
    public static func retire(owner: UUID) {
        if self.owner == owner { retiring = true; authorize = nil }
    }

    /// Capture before the first permission await so an old start can never
    /// consume a replacement owner's decision after close or navigation.
    public static func startTicket() throws -> UUID {
        guard let owner, !retiring else { throw NativeAuthError.unavailable }
        return owner
    }

    /// Final check and native begin execute together on MainActor, with no await
    /// between them. Retirement fences both pending authorization and later starts.
    public static func consume<T>(owner expected: UUID,
        start: @MainActor (NativeCapturePermit) throws -> T) async throws -> T {
        guard owner == expected, !retiring, !authorizing, let authorize else {
            throw NativeAuthError.unavailable
        }
        authorizing = true; defer { authorizing = false }
        let permit = try await authorize()
        guard owner == expected, !retiring, permit.startExpiresAt > Date() else {
            throw NativeAuthError.unavailable
        }
        return try start(permit)
    }

    /// Native boot recovery must hold idle for the entire authenticated stop.
    /// A missing PCM idle probe is not evidence of physical cessation.
    public static func recoverWhileIdle(_ operation: @MainActor () async throws -> Void) async throws {
        guard owner == nil, !authorizing, !recovering, let idle, idle() else { throw NativeAuthError.busy }
        recovering = true; defer { recovering = false }
        try await operation()
        guard owner == nil, !authorizing, idle() else { throw NativeAuthError.busy }
    }

    public static func confirmStopped(owner expected: UUID) throws {
        guard owner == expected else { throw NativeAuthError.unavailable }
        retiring = true
        guard !authorizing, let idle, idle() else { throw NativeAuthError.busy }
    }
}
