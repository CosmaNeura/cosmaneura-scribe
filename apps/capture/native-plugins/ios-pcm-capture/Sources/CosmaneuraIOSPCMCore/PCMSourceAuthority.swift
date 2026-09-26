import Foundation

public struct PCMSourceAuthority: Equatable, Sendable {
  /// Matches the capture protocol's total position budget. Each admitted window
  /// still requires its own short deadline and cumulative chunk allowance.
  public static let maximumChunksPerRun = 2_048
  public let runID: String
  public let generation: Int
  public let expiresAtMilliseconds: Int64
  public let hardMaximumChunks: Int

  public init(runID: String, generation: Int, expiresAtMilliseconds: Int64,
    hardMaximumChunks: Int) throws
  {
    guard UUID(uuidString: runID)?.uuidString.lowercased() == runID,
      generation > 0, generation <= 9_007_199_254_740_991,
      expiresAtMilliseconds > 0, expiresAtMilliseconds <= 9_007_199_254_740_991,
      (1...Self.maximumChunksPerRun).contains(hardMaximumChunks)
    else { throw PCMFailure(.invalidConfiguration) }
    self.runID = runID
    self.generation = generation
    self.expiresAtMilliseconds = expiresAtMilliseconds
    self.hardMaximumChunks = hardMaximumChunks
  }
}

public struct PCMSourceExtension: Equatable, Sendable {
  public let runID: String
  public let generation: Int
  public let expiresAtMilliseconds: Int64
  /// Cumulative chunks from the original Start, never an additional allowance.
  public let maximumChunks: Int

  public init(runID: String, generation: Int, expiresAtMilliseconds: Int64,
    maximumChunks: Int)
  {
    self.runID = runID
    self.generation = generation
    self.expiresAtMilliseconds = expiresAtMilliseconds
    self.maximumChunks = maximumChunks
  }
}

public enum PCMWindowCloseReason: String, Sendable {
  case authorityExpired = "authority_expired"
  case frameLimit = "frame_limit"
}

public struct PCMSourceTime: Sendable {
  public let epochMilliseconds: Int64
  public let monotonicNanoseconds: UInt64

  public init(epochMilliseconds: Int64, monotonicNanoseconds: UInt64) {
    self.epochMilliseconds = epochMilliseconds
    self.monotonicNanoseconds = monotonicNanoseconds
  }
}

/// Separate from the WebView heartbeat clock. ContinuousClock includes system
/// suspension; a wall-clock rollback cannot extend an admitted native window.
public protocol PCMSourceClock: Sendable {
  func now() -> PCMSourceTime
  func sleep(nanoseconds: UInt64) async throws
}

public struct ContinuousPCMSourceClock: PCMSourceClock {
  private let origin = ContinuousClock.now
  public init() {}

  public func now() -> PCMSourceTime {
    let elapsed = origin.duration(to: ContinuousClock.now).components
    return PCMSourceTime(
      epochMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000),
      monotonicNanoseconds: UInt64(elapsed.seconds) * 1_000_000_000
        + UInt64(elapsed.attoseconds / 1_000_000_000))
  }

  public func sleep(nanoseconds: UInt64) async throws {
    try await ContinuousClock().sleep(for: .nanoseconds(nanoseconds))
  }
}

struct PCMSourceWindow: Sendable {
  private(set) var authority: PCMSourceAuthority
  private(set) var maximumChunks: Int
  private var monotonicDeadline: UInt64

  init(authority: PCMSourceAuthority, maximumChunks: Int, now: PCMSourceTime) throws {
    guard maximumChunks > 0, maximumChunks <= authority.hardMaximumChunks else {
      throw PCMFailure(.invalidConfiguration)
    }
    self.authority = authority
    self.maximumChunks = maximumChunks
    monotonicDeadline = try Self.deadline(authority.expiresAtMilliseconds, now: now)
  }

  func remainingNanoseconds(_ now: PCMSourceTime) -> UInt64 {
    guard now.epochMilliseconds < authority.expiresAtMilliseconds,
      now.monotonicNanoseconds < monotonicDeadline else { return 0 }
    let wallMilliseconds = min(905_000, authority.expiresAtMilliseconds - now.epochMilliseconds)
    return min(UInt64(wallMilliseconds) * 1_000_000,
      monotonicDeadline - now.monotonicNanoseconds)
  }

  mutating func extend(_ value: PCMSourceExtension, now: PCMSourceTime) throws {
    guard remainingNanoseconds(now) > 0, value.runID == authority.runID,
      value.maximumChunks >= maximumChunks,
      value.maximumChunks <= authority.hardMaximumChunks else {
      throw PCMFailure(.invalidConfiguration)
    }
    if value.generation == authority.generation,
      value.expiresAtMilliseconds == authority.expiresAtMilliseconds,
      value.maximumChunks == maximumChunks { return }
    guard value.generation == authority.generation + 1,
      value.expiresAtMilliseconds > authority.expiresAtMilliseconds else {
      throw PCMFailure(.invalidConfiguration)
    }
    let next = try PCMSourceAuthority(runID: value.runID, generation: value.generation,
      expiresAtMilliseconds: value.expiresAtMilliseconds,
      hardMaximumChunks: authority.hardMaximumChunks)
    let deadline = try Self.deadline(value.expiresAtMilliseconds, now: now)
    authority = next
    maximumChunks = value.maximumChunks
    monotonicDeadline = deadline
  }

  private static func deadline(_ expires: Int64, now: PCMSourceTime) throws -> UInt64 {
    guard now.epochMilliseconds >= 0, expires > now.epochMilliseconds,
      expires - now.epochMilliseconds <= 905_000 else {
      throw PCMFailure(.invalidConfiguration)
    }
    let duration = UInt64(expires - now.epochMilliseconds) * 1_000_000
    guard now.monotonicNanoseconds <= UInt64.max - duration else {
      throw PCMFailure(.invalidConfiguration)
    }
    return now.monotonicNanoseconds + duration
  }
}
