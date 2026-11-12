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

  /// Race an async operation against the deadline using unstructured tasks.
  /// On timeout this records an Issue, cancels the work task, and throws without
  /// awaiting the loser — so a stuck `session.stop` or deferred-retirement wait
  /// cannot keep the suite hanging after the deadline.
  static func withDeadline<T: Sendable>(
    _ label: String,
    timeout: Duration = .seconds(3),
    _ work: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    final class Settlement: @unchecked Sendable {
      private let lock = NSLock()
      private var finished = false
      /// Returns true exactly once, for the winner of the race.
      func claim() -> Bool {
        lock.withLock {
          if finished { return false }
          finished = true
          return true
        }
      }
    }

    let settlement = Settlement()
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
      let workTask = Task<Void, Never> {
        let outcome: Result<T, Error>
        do {
          outcome = .success(try await work())
        } catch {
          outcome = .failure(error)
        }
        guard settlement.claim() else { return }
        continuation.resume(with: outcome)
      }

      Task<Void, Never> {
        do {
          try await Task.sleep(for: timeout)
        } catch {
          // Sleep cancelled only if this timeout task is cancelled; ignore.
          return
        }
        guard settlement.claim() else { return }
        // Do not await workTask: cancellation is best-effort, and a stuck wait
        // that ignores cancellation must not block returning to the test.
        workTask.cancel()
        Issue.record("Timed out after \(timeout) waiting for \(label)")
        continuation.resume(throwing: TimeoutError(label: label, timeout: timeout))
      }
    }
  }
}
