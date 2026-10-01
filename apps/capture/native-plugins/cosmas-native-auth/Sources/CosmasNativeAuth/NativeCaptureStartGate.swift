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
    public enum Consumer: Sendable { case legacyMicrophone, nativeEncryptedMicrophone }
    private static var owner: UUID?
    private static var authorize: (@MainActor () async throws -> NativeCapturePermit)?
    private static var legacyIdle: [@MainActor () -> Bool] = []
    private static var encryptedIdle: (@MainActor () -> Bool)?
    private static var consumer = Consumer.legacyMicrophone
    private static var consumed = false
    private static var closureConfirmed = false
    private static var retiring = false
    private static var authorizing = false
    private static var recovering = false

    /// Native PCM supplies the process-wide ownership check; no JS callback.
    public static func registerIdleProbe(_ probe: @escaping @MainActor () -> Bool) {
        // A plugin reload must not replace the probe retaining an older recorder.
        legacyIdle.append(probe)
    }

    public static func install(owner: UUID,
                               authorize: @escaping @MainActor () async throws -> NativeCapturePermit) throws {
        try install(owner: owner, consumer: .legacyMicrophone, encryptedIdle: nil, authorize: authorize)
    }

    /// Retains the native graph until its physical closure and original Core stop
    /// are confirmed. Legacy renderer calls cannot consume this owner's permit.
    public static func installEncrypted(owner: UUID, idle: @escaping @MainActor () -> Bool,
        authorize: @escaping @MainActor () async throws -> NativeCapturePermit) throws {
        try install(owner: owner, consumer: .nativeEncryptedMicrophone, encryptedIdle: idle, authorize: authorize)
    }

    private static func install(owner: UUID, consumer: Consumer,
        encryptedIdle: (@MainActor () -> Bool)?,
        authorize: @escaping @MainActor () async throws -> NativeCapturePermit) throws {
        guard !recovering, !authorizing, !consumed, allIdle(),
              self.owner == nil || (self.owner == owner && self.consumer == consumer && !retiring),
              encryptedIdle?() ?? true else { throw NativeAuthError.busy }
        if self.owner == nil { retiring = false }
        self.consumer = consumer; self.encryptedIdle = encryptedIdle; closureConfirmed = false
        self.owner = owner; self.authorize = authorize
    }

    public static func clear(owner: UUID) {
        if self.owner == owner, retiring, closureConfirmed, !authorizing, allIdle() {
            self.owner = nil; self.authorize = nil; encryptedIdle = nil
            consumed = false; closureConfirmed = false
        }
    }

    /// Keep the owner marker until physical closure is confirmed. An in-flight
    /// authorization cannot cross this fence, even after the same account returns.
    public static func retire(owner: UUID) {
        if self.owner == owner { retiring = true; authorize = nil }
    }

    /// Capture before the first permission await so an old start can never
    /// consume a replacement owner's decision after close or navigation.
    public static func startTicket(consumer: Consumer = .legacyMicrophone) throws -> UUID {
        guard let owner, self.consumer == consumer, !retiring, !consumed else { throw NativeAuthError.unavailable }
        return owner
    }

    /// Final check and native begin execute together on MainActor, with no await
    /// between them. Retirement fences both pending authorization and later starts.
    public static func consume<T>(owner expected: UUID, consumer: Consumer = .legacyMicrophone,
        start: @MainActor (NativeCapturePermit) throws -> T) async throws -> T {
        guard owner == expected, self.consumer == consumer, !retiring, !authorizing,
              !consumed, allIdle(), let authorize else {
            throw NativeAuthError.unavailable
        }
        authorizing = true; defer { authorizing = false }
        let permit = try await authorize()
        guard owner == expected, !retiring, allIdle(), permit.startExpiresAt > Date() else {
            throw NativeAuthError.unavailable
        }
        consumed = true
        return try start(permit)
    }

    /// Renewal validates the continuing owner; the PCM window enforces the
    /// current lease deadline. The first lease's expiry is not a new start grant.
    public static func requireActiveEncryptedOwner(_ expected: UUID) throws {
        guard owner == expected, consumer == .nativeEncryptedMicrophone, consumed, !retiring else {
            throw NativeAuthError.unavailable
        }
    }

    /// Original encrypted owner only, after new capture has been fenced. This
    /// grants no Start/renewal; the source must separately verify current account
    /// and retained stop custody before a synchronous final queue write.
    public static func requireEncryptedFinalizationOwner(_ expected: UUID) throws {
        guard owner == expected, consumer == .nativeEncryptedMicrophone, consumed,
              !closureConfirmed else { throw NativeAuthError.unavailable }
    }

    /// Native boot recovery must hold idle for the entire authenticated stop.
    /// A missing PCM idle probe is not evidence of physical cessation.
    public static func recoverWhileIdle(_ operation: @MainActor () async throws -> Void) async throws {
        guard owner == nil, !authorizing, !recovering, allIdle() else { throw NativeAuthError.busy }
        recovering = true; defer { recovering = false }
        try await operation()
        guard owner == nil, !authorizing, allIdle() else { throw NativeAuthError.busy }
    }

    public static func confirmStopped(owner expected: UUID) throws {
        guard owner == expected else { throw NativeAuthError.unavailable }
        retiring = true
        guard !authorizing, allIdle() else { throw NativeAuthError.busy }
        closureConfirmed = true
    }

    private static func allIdle() -> Bool {
        !legacyIdle.isEmpty && legacyIdle.allSatisfy { $0() } && (encryptedIdle?() ?? true)
    }
}
