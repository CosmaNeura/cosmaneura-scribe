import Foundation
import OSLog

/// Per-invocation numeric observations only. No request, response, credential,
/// URL, identity or exception value is accepted or retained by this ledger.
enum NativeTokenRequestObservation {
    @TaskLocal static var current: NativeTokenRequestTiming?
}

struct NativeTokenRequestSnapshot: Sendable, Equatable {
    let totalMilliseconds: Int
    let httpMilliseconds: Int
    let requests: Int
    let responses: Int
    let retryableResponses: Int
    let pendingRequests: Int
    let completed: Bool

    private static let logger = Logger(subsystem: "com.cosmaneura.scribe.performance", category: "token")

    func log() {
        Self.logger.info("provider_token total_ms=\(totalMilliseconds) http_ms=\(httpMilliseconds) requests=\(requests) responses=\(responses) retryable_responses=\(retryableResponses) pending_requests=\(pendingRequests) completed=\(completed)")
    }
}

/// Middleware callbacks can cross SDK tasks. The lock owns the numeric state;
/// closing freezes it, so late responses cannot alter a finished observation.
final class NativeTokenRequestTiming: @unchecked Sendable {
    private let lock = NSLock()
    private let now: @Sendable () -> ContinuousClock.Instant
    private let started: ContinuousClock.Instant
    private var closed = false
    private var active = 0
    private var httpStarted: ContinuousClock.Instant?
    private var httpMilliseconds = 0
    private var requests = 0
    private var responses = 0
    private var retryableResponses = 0
    private var snapshot: NativeTokenRequestSnapshot?

    init(now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }) {
        self.now = now
        started = now()
    }

    func requestStarted() {
        lock.withLock {
            guard !closed else { return }
            if active == 0 { httpStarted = now() }
            active += 1
            requests = min(64, requests + 1)
        }
    }

    func responseReceived(status: Int) {
        lock.withLock {
            guard !closed, active > 0 else { return }
            responses = min(64, responses + 1)
            if [408, 425, 429, 500, 502, 503, 504].contains(status) {
                retryableResponses = min(64, retryableResponses + 1)
            }
            active -= 1
            if active == 0 { finishHTTP(at: now()) }
        }
    }

    func finish(completed: Bool) -> NativeTokenRequestSnapshot {
        lock.withLock {
            if let snapshot { return snapshot }
            let end = now()
            finishHTTP(at: end)
            closed = true
            let result = NativeTokenRequestSnapshot(
                totalMilliseconds: Self.milliseconds(started, end),
                httpMilliseconds: httpMilliseconds,
                requests: requests, responses: responses,
                retryableResponses: retryableResponses,
                pendingRequests: min(64, active), completed: completed
            )
            snapshot = result
            return result
        }
    }

    private func finishHTTP(at end: ContinuousClock.Instant) {
        if let start = httpStarted {
            httpMilliseconds = min(60_000, httpMilliseconds + Self.milliseconds(start, end))
            httpStarted = nil
        }
    }

    private static func milliseconds(_ start: ContinuousClock.Instant, _ end: ContinuousClock.Instant) -> Int {
        let parts = start.duration(to: end).components
        let value = Double(parts.seconds) * 1000 + Double(parts.attoseconds) / 1e15
        return Int(min(60_000, max(0, value)).rounded())
    }
}
