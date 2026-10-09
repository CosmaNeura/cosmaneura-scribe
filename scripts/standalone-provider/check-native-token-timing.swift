import Foundation

enum TimingCheckFailure: Error { case failed }
func require(_ condition: Bool) throws {
    guard condition else { throw TimingCheckFailure.failed }
}

final class TimingClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = ContinuousClock.now
    func now() -> ContinuousClock.Instant { lock.withLock { value } }
    func advance(_ milliseconds: Int) { lock.withLock { value += .milliseconds(milliseconds) } }
}

@main struct CheckNativeTokenTiming {
    static func main() async throws {
        var checks = 0
        do {
            let clock = TimingClock(), timing = NativeTokenRequestTiming(now: { clock.now() })
            clock.advance(10); timing.requestStarted()
            clock.advance(500); timing.responseReceived(status: 200)
            clock.advance(20)
            let result = timing.finish(completed: true)
            try require(result.totalMilliseconds == 530 && result.httpMilliseconds == 500)
            try require(result.requests == 1 && result.responses == 1 && result.retryableResponses == 0 && result.pendingRequests == 0)
            checks += 1
        }
        do {
            let clock = TimingClock(), timing = NativeTokenRequestTiming(now: { clock.now() })
            timing.requestStarted(); clock.advance(250); timing.responseReceived(status: 503)
            clock.advance(500); timing.requestStarted(); clock.advance(250); timing.responseReceived(status: 200)
            let result = timing.finish(completed: true)
            try require(result.totalMilliseconds == 1000 && result.httpMilliseconds == 500)
            try require(result.requests == 2 && result.responses == 2 && result.retryableResponses == 1)
            checks += 1
        }
        do {
            let clock = TimingClock(), timing = NativeTokenRequestTiming(now: { clock.now() })
            timing.responseReceived(status: 200)
            timing.requestStarted(); clock.advance(700)
            let result = timing.finish(completed: false)
            try require(!result.completed && result.pendingRequests == 1 && result.responses == 0 && result.httpMilliseconds == 700)
            clock.advance(1000); timing.requestStarted(); timing.responseReceived(status: 503)
            try require(timing.finish(completed: true) == result)
            checks += 1
        }
        do {
            let clock = TimingClock(), timing = NativeTokenRequestTiming(now: { clock.now() })
            timing.requestStarted(); clock.advance(50); timing.requestStarted()
            clock.advance(50); timing.responseReceived(status: 200)
            clock.advance(50); timing.responseReceived(status: 200)
            try require(timing.finish(completed: true).httpMilliseconds == 150)
            checks += 1
        }
        do {
            let timing = NativeTokenRequestTiming()
            for _ in 0..<100 { timing.requestStarted(); timing.responseReceived(status: 429) }
            let result = timing.finish(completed: true)
            try require(result.requests == 64 && result.responses == 64 && result.retryableResponses == 64)
            let clock = TimingClock(), bounded = NativeTokenRequestTiming(now: { clock.now() })
            bounded.requestStarted(); clock.advance(120_000)
            let maximum = bounded.finish(completed: false)
            try require(maximum.totalMilliseconds == 60_000 && maximum.httpMilliseconds == 60_000)
            checks += 1
        }
        do {
            let outer = NativeTokenRequestTiming(), inner = NativeTokenRequestTiming()
            try await NativeTokenRequestObservation.$current.withValue(outer) {
                await Task { NativeTokenRequestObservation.current?.requestStarted() }.value
                await NativeTokenRequestObservation.$current.withValue(inner) {
                    await Task { NativeTokenRequestObservation.current?.requestStarted() }.value
                    NativeTokenRequestObservation.current?.responseReceived(status: 200)
                }
                try require(NativeTokenRequestObservation.current === outer)
                let detached = await Task.detached { NativeTokenRequestObservation.current == nil }.value
                try require(detached)
                NativeTokenRequestObservation.current?.responseReceived(status: 200)
            }
            try require(NativeTokenRequestObservation.current == nil)
            try require(outer.finish(completed: true).requests == 1 && inner.finish(completed: true).requests == 1)
            checks += 1
        }
        do {
            let first = NativeTokenRequestTiming(), second = NativeTokenRequestTiming()
            await withTaskGroup(of: Void.self) { group in
                for timing in [first, second] {
                    group.addTask {
                        await NativeTokenRequestObservation.$current.withValue(timing) {
                            await Task { NativeTokenRequestObservation.current?.requestStarted() }.value
                            NativeTokenRequestObservation.current?.responseReceived(status: 200)
                        }
                    }
                }
            }
            try require(first.finish(completed: true).requests == 1 && second.finish(completed: true).requests == 1)
            checks += 1
        }
        print("Native token numeric timing checks passed: \(checks); offline, no account or audio access.")
    }
}
