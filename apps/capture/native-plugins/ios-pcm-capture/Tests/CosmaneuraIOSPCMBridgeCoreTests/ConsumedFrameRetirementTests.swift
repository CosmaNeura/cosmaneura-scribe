import Foundation
import Testing

@testable import CosmaneuraIOSAVFoundationDriver
@testable import CosmaneuraIOSPCMCore

@Suite(.timeLimit(.minutes(1)))
struct ConsumedFrameRetirementTests {
  @Test func nextCallbackCannotObserveReleasedAdmissionBeforeConsumedPublication() async throws {
    // Explicit synthetic consent; no OS audio, source, real identity or data.
    let consent = (allPartiesConsented: true, recordID: UUID())
    try #require(consent.allPartiesConsented)
    let book = AdmissionBook(), failures = AdmissionFailures(), releases = AdmissionReleases()
    let releaseEntered = DispatchSemaphore(value: 0), finishRelease = DispatchSemaphore(value: 0)
    let callbackEntered = DispatchSemaphore(value: 0), callbackReturned = DispatchSemaphore(value: 0)
    let second = RetirementLatch()
    let gate = DriverCallbackGate(continueInBackground: true, diagnostics: PCMStartupDiagnostics())
    defer {
      finishRelease.signal()
      second.open()
    }
    gate.activate(generation: 1, callbacks: PCMAudioCallbacks(
      frames: { frames in
        let index = book.count
        let receipt = PCMFrameAdmission(consuming: {
          if index == 1 { await second.wait() }
          frames.zeroize()
        }, release: {
          // Exercise the actual nonempty release callback, after the modeled
          // core admission is free but before receipt publication can occur.
          releases.record()
          if index == 0 {
            releaseEntered.signal()
            _ = finishRelease.wait(timeout: .now() + 2)
          }
        })
        book.append(receipt)
        return receipt
      }, event: { failures.record($0) }, invalidate: { failures.invalidate($0) }))
    try #require(gate.arm(generation: 1))
    let firstFrames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    gate.receive(frames: firstFrames, generation: 1)
    let releaseArrived = await waitForBoundary(releaseEntered)
    try #require(releaseArrived == .success)
    #expect(releases.count == 1 && firstFrames.isZeroed)
    let nextFrames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    DispatchQueue.global().async {
      callbackEntered.signal()
      gate.receive(frames: nextFrames, generation: 1)
      callbackReturned.signal()
    }
    let callbackArrived = await waitForBoundary(callbackEntered)
    try #require(callbackArrived == .success)
    // The callback must wait for the coupled release/publication. The prior
    // separate-lock implementation returns immediately with a false overflow.
    let returnedDuringRelease = await waitForBoundary(callbackReturned, timeout: .milliseconds(100))
    #expect(returnedDuringRelease == .timedOut)
    finishRelease.signal()
    let returnedAfterRelease = await waitForBoundary(callbackReturned)
    try #require(returnedAfterRelease == .success)
    #expect(book.count == 2 && failures.count == 0)
    let first = try #require(book.receipt(0)), next = try #require(book.receipt(1))
    try await PCMTestWait.until("first receipt consumed") { first.isConsumed }
    #expect(first.isConsumed && releases.count == 1)
    second.open()
    try await PCMTestWait.until("next receipt consumed") { next.isConsumed }
    gate.freezeFrames(generation: 1)
    if let terminal = gate.retireAdmission(generation: 1) {
      try await PCMTestWait.withDeadline("retireAdmission delivery") { await terminal.value }
    }
    #expect(nextFrames.isZeroed && next.isConsumed && releases.count == 2)
  }

  @Test func consumedFrameCanAdvanceBeforeItsAwaitingTaskRetires() async throws {
    // Explicit synthetic consent; no OS audio, source, real identity or data.
    let consent = (allPartiesConsented: true, recordID: UUID())
    try #require(consent.allPartiesConsented)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(consent.recordID.uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let diagnostics = PCMStartupDiagnostics()
    let path = directory.appendingPathComponent("diagnostics.json")
    diagnostics.configure(destination: path); diagnostics.record(.startRequested)
    let retire = RetirementLatch(), second = RetirementLatch()
    let retirementEntries = CallCounter(), retirementCompletions = CallCounter()
    let book = AdmissionBook(), failures = AdmissionFailures()
    defer {
      retire.open()
      second.open()
    }
    let gate = DriverCallbackGate(continueInBackground: true, diagnostics: diagnostics,
      deferredRetirement: { complete in
        retirementEntries.increment()
        await retire.wait()
        complete()
        retirementCompletions.increment()
      })
    gate.activate(generation: 1, callbacks: PCMAudioCallbacks(
      frames: { frames in
        let index = book.count
        let receipt = PCMFrameAdmission(consuming: {
          if index == 1 { await second.wait() }
          frames.zeroize()
        }, release: {})
        book.append(receipt)
        return receipt
      }, event: { failures.record($0) }, invalidate: { failures.invalidate($0) }))
    try #require(gate.arm(generation: 1))
    let firstFrames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    gate.receive(frames: firstFrames, generation: 1)
    let first = try #require(book.receipt(0))
    try await PCMTestWait.until("first receipt consumed") { first.isConsumed }
    #expect(first.isConsumed && firstFrames.isZeroed)
    try await PCMTestWait.until("first retirement entered") { retirementEntries.count >= 1 }

    // The old retirement task is deliberately held AFTER actual consumption.
    // There remains exactly one unconsumed buffer, not a larger input queue.
    let secondFrames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    gate.receive(frames: secondFrames, generation: 1)
    try await PCMTestWait.until("second receipt admitted") { book.receipt(1) != nil }
    let secondReceipt = try #require(book.receipt(1))
    let acceptedAfterConsumed = book.count
    let failuresBeforeUnconsumedOverlap = failures.count
    retire.open()
    // Do not assume which deferred-retirement completion arrives first; wait for
    // the first frame's completion count before overlapping the unconsumed second.
    try await PCMTestWait.until("first retirement completed") { retirementCompletions.count >= 1 }

    // A late completion of the first frame must not clear the second frame's
    // admission. An actually unconsumed overlap must still fail and zeroize.
    let rejected = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    gate.receive(frames: rejected, generation: 1)
    second.open()
    try await PCMTestWait.until("second receipt consumed") { secondReceipt.isConsumed }
    gate.freezeFrames(generation: 1)
    if let terminal = gate.retireAdmission(generation: 1) {
      try await PCMTestWait.withDeadline("retireAdmission delivery") { await terminal.value }
    }
    await diagnostics.flush()
    #expect(acceptedAfterConsumed == 2)
    #expect(failuresBeforeUnconsumedOverlap == 0)
    #expect(book.count == 2)
    #expect(rejected.isZeroed && secondFrames.isZeroed)
    #expect(failures.count == 1 && failures.invalidations == 1)
    let rows = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [[String: Any]])
    #expect(rows.filter { $0["event"] as? String == "driverAdmissionOverflow" }.count == 1)
  }
}

private func waitForBoundary(
  _ semaphore: DispatchSemaphore, timeout: DispatchTimeInterval = .seconds(2)
) async -> DispatchTimeoutResult {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async {
      continuation.resume(returning: semaphore.wait(timeout: .now() + timeout))
    }
  }
}

private actor RetirementLatch {
  private var opened = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func wait() async {
    if opened { return }
    await withCheckedContinuation { waiters.append($0) }
  }
  func open() {
    opened = true
    let pending = waiters; waiters.removeAll()
    for waiter in pending { waiter.resume() }
  }
}

private final class CallCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.withLock { value } }
  func increment() { lock.withLock { value += 1 } }
}

private final class AdmissionBook: @unchecked Sendable {
  private let lock = NSLock()
  private var receipts: [PCMFrameAdmission] = []
  var count: Int { lock.withLock { receipts.count } }
  func append(_ receipt: PCMFrameAdmission) { lock.withLock { receipts.append(receipt) } }
  func receipt(_ index: Int) -> PCMFrameAdmission? {
    lock.withLock { receipts.indices.contains(index) ? receipts[index] : nil }
  }
}

private final class AdmissionFailures: @unchecked Sendable {
  private let lock = NSLock()
  private var events = 0, invalidated = 0
  var count: Int { lock.withLock { events } }
  var invalidations: Int { lock.withLock { invalidated } }
  func record(_ event: PCMAudioEvent) {
    if event == .captureFailed { lock.withLock { events += 1 } }
  }
  func invalidate(_ event: PCMAudioEvent) {
    if event == .captureFailed { lock.withLock { invalidated += 1 } }
  }
}

private final class AdmissionReleases: @unchecked Sendable {
  private let lock = NSLock()
  private var released = 0
  var count: Int { lock.withLock { released } }
  func record() { lock.withLock { released += 1 } }
}
