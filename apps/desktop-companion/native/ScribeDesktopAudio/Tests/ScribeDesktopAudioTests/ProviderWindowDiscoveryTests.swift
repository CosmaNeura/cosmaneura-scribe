import Foundation
import Testing
@testable import ScribeDesktopAudio

// The withheld lookup deliberately ignores task cancellation. No permissions,
// window enumeration, native app, microphone or saved recording is accessed.
@MainActor
private final class WithheldWindowLookup {
    private var pending: CheckedContinuation<[Int], Never>?
    let entered: AsyncStream<Void>
    private let entry: AsyncStream<Void>.Continuation
    init() { (entered, entry) = AsyncStream.makeStream() }
    func load() async -> [Int] {
        await withCheckedContinuation { pending in
            self.pending = pending; entry.yield(()); entry.finish()
        }
    }
    func complete() { pending?.resume(returning: [41, 73]); pending = nil }
}

@Test @MainActor
func windowDiscoveryReturnsAReadyListWithoutWaitingForItsDeadline() async throws {
    let started = ContinuousClock.now
    let result = try await ProviderWindowDiscovery<[Int]>().load(timeout: .seconds(10)) { [41, 73] }
    #expect(result == [41, 73])
    #expect(ContinuousClock.now - started < .seconds(1))
}

@Test @MainActor
func windowDiscoveryCancellationDoesNotWaitForAnUncooperativeLookup() async throws {
    let lookup = WithheldWindowLookup()
    let task = Task { @MainActor in
        try await ProviderWindowDiscovery<[Int]>().load { await lookup.load() }
    }
    for await _ in lookup.entered { break }
    let cancelledAt = ContinuousClock.now
    task.cancel()
    do {
        _ = try await task.value
        Issue.record("A cancelled lookup returned a window choice")
    } catch {
        #expect(ContinuousClock.now - cancelledAt < .seconds(1))
    }
    // Completion after Cancel is observed and discarded; it cannot restore a
    // stale picker or prevent a fresh lookup from serving the next attempt.
    lookup.complete()
    let next = try await ProviderWindowDiscovery<[Int]>().load { [99] }
    #expect(next == [99])
}

@Test @MainActor
func windowDiscoveryDeadlineDoesNotWaitForAnUncooperativeLookup() async throws {
    let lookup = WithheldWindowLookup()
    let started = ContinuousClock.now
    do {
        _ = try await ProviderWindowDiscovery<[Int]>().load(timeout: .milliseconds(25)) { await lookup.load() }
        Issue.record("A lookup passed its deadline without a result")
    } catch {
        #expect(ContinuousClock.now - started < .seconds(1))
    }
    lookup.complete()
    let next = try await ProviderWindowDiscovery<[Int]>().load { [99] }
    #expect(next == [99])
}

@Test @MainActor
func cancelledWindowDiscoveryNeverBeginsAPlatformLookup() async {
    var calls = 0
    let task = Task { @MainActor in
        try await ProviderWindowDiscovery<[Int]>().load { calls += 1; return [] }
    }
    task.cancel()
    _ = await task.result
    #expect(calls == 0)
}
