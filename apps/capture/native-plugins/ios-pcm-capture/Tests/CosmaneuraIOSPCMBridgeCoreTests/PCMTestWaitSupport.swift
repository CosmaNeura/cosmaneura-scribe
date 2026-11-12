import Foundation
import Testing

/// Shared bounded wait for native PCM tests. Generalized from the former
/// `waitForCalls` helper: poll a condition until it holds or the deadline
/// (default 3s) elapses, then record an Issue and throw.
enum PCMTestWait {
  struct TimeoutError: Error, CustomStringConvertible {
    let label: String
    let timeout: Duration
    var description: String { "Timed out after \(timeout) waiting for \(label)" }
  }

  static func until(
    _ label: String,
    timeout: Duration = .seconds(3),
    _ condition: @Sendable () -> Bool
  ) async throws {
    let deadline = ContinuousClock.now + timeout
    while !condition() && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(1))
    }
    guard condition() else {
      Issue.record("Timed out after \(timeout) waiting for \(label)")
      throw TimeoutError(label: label, timeout: timeout)
    }
  }

  /// Race an async operation against the same deadline. Cancels the loser.
  static func withDeadline<T: Sendable>(
    _ label: String,
    timeout: Duration = .seconds(3),
    _ work: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await work() }
      group.addTask {
        try await Task.sleep(for: timeout)
        Issue.record("Timed out after \(timeout) waiting for \(label)")
        throw TimeoutError(label: label, timeout: timeout)
      }
      let value = try await group.next()!
      group.cancelAll()
      return value
    }
  }
}
