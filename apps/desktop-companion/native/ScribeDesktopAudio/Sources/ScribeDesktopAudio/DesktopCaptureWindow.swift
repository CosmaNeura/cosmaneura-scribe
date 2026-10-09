import Foundation

/// Trusted native/main-process metadata for an already authorized source. The
/// caller must verify Core's lease and durable reservations before supplying it.
/// This value grants no permission and cannot choose or start another source.
public struct DesktopCaptureAuthorization: Equatable, Sendable {
    public let runID: String
    public let generation: Int
    public let expiresAtMilliseconds: Int64
    public let maximumOutputFrames: Int
    public let hardMaximumOutputFrames: Int

    public init(runID: String, generation: Int, expiresAtMilliseconds: Int64,
                maximumOutputFrames: Int, hardMaximumOutputFrames: Int) throws {
        guard UUID(uuidString: runID)?.uuidString.lowercased() == runID,
              (1...9_007_199_254_740_991).contains(generation),
              (1...9_007_199_254_740_991).contains(expiresAtMilliseconds),
              (1...1_382_400_000).contains(hardMaximumOutputFrames),
              (1...hardMaximumOutputFrames).contains(maximumOutputFrames) else {
            throw DesktopAudioFailure.invalidAudio
        }
        self.runID = runID; self.generation = generation
        self.expiresAtMilliseconds = expiresAtMilliseconds
        self.maximumOutputFrames = maximumOutputFrames
        self.hardMaximumOutputFrames = hardMaximumOutputFrames
    }
}

struct DesktopCaptureTime: Sendable {
    let epochMilliseconds: Int64
    let monotonic: ContinuousClock.Instant
    static var now: Self {
        Self(epochMilliseconds: Int64(Date().timeIntervalSince1970 * 1000), monotonic: .now)
    }
}

/// Both clocks must remain inside the last admitted window. A wall-clock change
/// or duplicate acknowledgement cannot enlarge its monotonic deadline.
struct DesktopCaptureWindow: Sendable {
    private(set) var authorization: DesktopCaptureAuthorization
    private var deadline: ContinuousClock.Instant

    init(_ authorization: DesktopCaptureAuthorization, now: DesktopCaptureTime) throws {
        guard authorization.generation == 1, authorization.maximumOutputFrames <= 905 * 16_000 else {
            throw DesktopAudioFailure.invalidAudio
        }
        self.authorization = authorization
        deadline = try Self.deadline(authorization, now: now)
    }

    func remaining(_ now: DesktopCaptureTime) -> Duration {
        guard now.epochMilliseconds >= 0, now.epochMilliseconds < authorization.expiresAtMilliseconds,
              now.monotonic < deadline else { return .zero }
        return min(.milliseconds(min(905_000, authorization.expiresAtMilliseconds - now.epochMilliseconds)),
                   now.monotonic.duration(to: deadline))
    }

    mutating func extend(_ next: DesktopCaptureAuthorization, now: DesktopCaptureTime) throws {
        guard remaining(now) > .zero, next.runID == authorization.runID,
              next.hardMaximumOutputFrames == authorization.hardMaximumOutputFrames,
              next.maximumOutputFrames >= authorization.maximumOutputFrames else {
            throw DesktopAudioFailure.invalidAudio
        }
        if next == authorization { return }
        guard next.generation == authorization.generation + 1,
              next.expiresAtMilliseconds > authorization.expiresAtMilliseconds,
              next.maximumOutputFrames - authorization.maximumOutputFrames <= 905 * 16_000 else {
            throw DesktopAudioFailure.invalidAudio
        }
        let nextDeadline = try Self.deadline(next, now: now)
        authorization = next; deadline = nextDeadline
    }

    private static func deadline(_ value: DesktopCaptureAuthorization, now: DesktopCaptureTime) throws -> ContinuousClock.Instant {
        guard now.epochMilliseconds >= 0, value.expiresAtMilliseconds > now.epochMilliseconds,
              value.expiresAtMilliseconds - now.epochMilliseconds <= 905_000 else {
            throw DesktopAudioFailure.invalidAudio
        }
        return now.monotonic.advanced(by: .milliseconds(value.expiresAtMilliseconds - now.epochMilliseconds))
    }
}

final class DesktopCaptureWindowOwner: @unchecked Sendable {
    private let lock = NSLock()
    private var window: DesktopCaptureWindow
    init(_ value: DesktopCaptureAuthorization) throws {
        window = try DesktopCaptureWindow(value, now: .now)
    }
    var remaining: Duration { lock.withLock { window.remaining(.now) } }
    func extend(_ value: DesktopCaptureAuthorization) throws {
        try lock.withLock { try window.extend(value, now: .now) }
    }
}
