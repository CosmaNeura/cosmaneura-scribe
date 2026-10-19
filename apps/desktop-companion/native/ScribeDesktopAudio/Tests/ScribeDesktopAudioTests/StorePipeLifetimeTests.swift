import Darwin
import Foundation
import Testing
@testable import ScribeDesktopAudio

@Test func storePipeCancellationDrainsPartialHeaderWithoutClosingBorrowedFD() async throws {
    let input = Pipe(), lifetime = NativeProcessLifetime()
    defer { try? input.fileHandleForReading.close(); try? input.fileHandleForWriting.close() }
    try input.fileHandleForWriting.write(contentsOf: Data([0]))
    let reading = Task.detached { () -> Bool in
        do { _ = try ProcessInput(input.fileHandleForReading, lifetime: lifetime).next(); return false }
        catch { return true }
    }
    try await Task.sleep(for: .milliseconds(50))
    lifetime.cancel()
    #expect(await reading.value)
    #expect(fcntl(input.fileHandleForReading.fileDescriptor, F_GETFD) >= 0)
    #expect(fcntl(input.fileHandleForWriting.fileDescriptor, F_GETFD) >= 0)
}

@Test func storePipeCancellationBeforeAdmissionIsIdempotentAndRetained() async throws {
    let lifetime = NativeProcessLifetime(), counter = StorePipeCounter()
    lifetime.cancel(); lifetime.cancel()
    lifetime.onCancel { counter.increment() }
    #expect(counter.value == 1)
    let input = Pipe()
    defer { try? input.fileHandleForReading.close(); try? input.fileHandleForWriting.close() }
    #expect(throws: CancellationError.self) { _ = try ProcessInput(input.fileHandleForReading, lifetime: lifetime).next() }
}

@Test @MainActor func storePipeCatalogueCancellationReturnsTransportFailureWithoutDeviceAccess() async {
    let input = Pipe(), output = Pipe(), lifetime = NativeProcessLifetime()
    defer { try? input.fileHandleForReading.close(); try? input.fileHandleForWriting.close(); try? output.fileHandleForReading.close(); try? output.fileHandleForWriting.close() }
    lifetime.cancel()
    let calls = StorePipeCounter()
    let catalogue = MicrophoneCatalogue(devices: { calls.increment(); return [] }, defaultUID: { "synthetic" }, authorized: { false })
    let result = await MicrophoneCheckProcess.run(input: input.fileHandleForReading, output: output.fileHandleForWriting,
        catalogue: catalogue, lifetime: lifetime)
    #expect(result == 70)
    #expect(calls.value == 0)
}

@Test func storePipeAvailabilityWriteFailureCannotReportCleanCompletion() async throws {
    let output = Pipe()
    try output.fileHandleForWriting.close()
    defer { try? output.fileHandleForReading.close() }
    #expect(!(await DesktopAudioProcess.writeAvailabilityResult(false, output: output.fileHandleForWriting)))
}

/// A synthetic source exposes a stop barrier; it never opens audio or devices.
@Test(arguments: [false, true]) func storePipeRunnerWaitsForConfirmedCleanupAndPartialReaderDrain(trailingMalformed: Bool) async throws {
    let input = Pipe(), output = Pipe(), lifetime = NativeProcessLifetime(), source = StorePipeStopBarrier()
    defer { try? input.fileHandleForReading.close(); try? input.fileHandleForWriting.close(); try? output.fileHandleForReading.close(); try? output.fileHandleForWriting.close() }
    let result = StorePipeResult()
    let running = Task {
        let code = await DesktopAudioProcess.run(source: source, input: input.fileHandleForReading,
            output: output.fileHandleForWriting, lifetime: lifetime)
        result.set(code); return code
    }
    let body = Data([1]) + (try JSONSerialization.data(withJSONObject: ["type": "stop", "request": 1, "mode": "discard"]))
    var length = UInt32(body.count).bigEndian
    var frame = withUnsafeBytes(of: &length) { Data($0) }; frame.append(body)
    try input.fileHandleForWriting.write(contentsOf: frame)
    let acknowledged = await Task.detached { () -> Bool in
        guard let header = try? output.fileHandleForReading.read(upToCount: 4), header.count == 4 else { return false }
        let count = header.reduce(0) { $0 * 256 + Int($1) }
        guard let payload = try? output.fileHandleForReading.read(upToCount: count), payload.count == count,
              let value = try? JSONSerialization.jsonObject(with: payload.dropFirst()) as? [String: Any] else { return false }
        return value["type"] as? String == "stopped"
    }.value
    #expect(acknowledged)
    await source.holdCleanup()
    if trailingMalformed {
        let invalidBody = Data([1]) + (try JSONSerialization.data(withJSONObject: ["type": "unknown"]))
        var invalidLength = UInt32(invalidBody.count).bigEndian
        var invalidFrame = withUnsafeBytes(of: &invalidLength) { Data($0) }; invalidFrame.append(invalidBody)
        try input.fileHandleForWriting.write(contentsOf: invalidFrame)
    } else {
        // Persistent writer plus incomplete next header exercises cancellation drain.
        try input.fileHandleForWriting.write(contentsOf: Data([0]))
        lifetime.cancel()
    }
    try await Task.sleep(for: .milliseconds(100))
    #expect(result.value == nil)
    await source.releaseCleanup()
    #expect(await running.value == (trailingMalformed ? 70 : 0))
    #expect(fcntl(input.fileHandleForReading.fileDescriptor, F_GETFD) >= 0)
}

private final class StorePipeCounter: @unchecked Sendable {
    private let lock = NSLock(); private var count = 0
    func increment() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}
private final class StorePipeResult: @unchecked Sendable {
    private let lock = NSLock(); private var code: Int32?
    func set(_ code: Int32) { lock.withLock { self.code = code } }
    var value: Int32? { lock.withLock { code } }
}
private actor StorePipeStopBarrier: DesktopProcessSource {
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func start(selection: MeetingAudioSelection, maximumDurationSeconds: Int, sink: any DesktopAudioSink) async throws {
        throw DesktopAudioFailure.unavailable
    }
    func stop(mode: DesktopAudioStopMode) async throws {
        if held { await withCheckedContinuation { waiters.append($0) } }
    }
    func holdCleanup() { held = true }
    func releaseCleanup() { held = false; for waiter in waiters { waiter.resume() }; waiters.removeAll() }
}

@Test @MainActor func storePipePresentationCloseWriteFailureCannotReportSuccess() async throws {
    let input = Pipe(), output = Pipe(), lifetime = NativeProcessLifetime()
    defer { try? input.fileHandleForReading.close(); try? input.fileHandleForWriting.close(); try? output.fileHandleForReading.close() }
    try output.fileHandleForWriting.close()
    let body = Data([1]) + (try JSONSerialization.data(withJSONObject: ["type": "close", "request": 1]))
    var length = UInt32(body.count).bigEndian
    var frame = withUnsafeBytes(of: &length) { Data($0) }; frame.append(body)
    try input.fileHandleForWriting.write(contentsOf: frame)
    let result = await ProviderPresentationProcess.run(surface: StorePipeFakeSurface(), input: input.fileHandleForReading,
        output: output.fileHandleForWriting, lifetime: lifetime)
    #expect(result == 70)
}
@MainActor private final class StorePipeFakeSurface: ProviderPresentationSurface {
    var onEvent: (@MainActor (ProviderPresentationEvent) -> Void)?
    func choose() async throws -> MeetingAudioSelection { throw ProviderPresentationFailure.unavailable }
    func publish(_ state: ProviderRecordingPresentation) throws {}
    func verifyVisibility() {}
}
