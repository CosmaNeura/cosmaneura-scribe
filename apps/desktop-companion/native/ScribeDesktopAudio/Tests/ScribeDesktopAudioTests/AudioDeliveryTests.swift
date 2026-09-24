import AVFoundation
import CoreMedia
import Foundation
import Testing
@testable import ScribeDesktopAudio

/// Every sample below is generated under this explicit invented consent fixture.
/// These tests never start an OS source or request capture permissions.
private struct ConsentedFixture {
    let consentID = UUID()
    let allPartiesAgreed = true
    func frame(_ time: UInt64 = 1, channel: DesktopAudioChannel = .microphone) throws -> DesktopAudioFrame {
        precondition(allPartiesAgreed)
        return try DesktopAudioFrame(channel: channel, sampleRate: 48_000, channels: 1,
                                     hostTimeNanoseconds: time, samples: [0.125, -0.25, 0.5])
    }
}

private final class Sink: DesktopAudioSink, @unchecked Sendable {
    private let lock = NSLock()
    private var failures: [DesktopAudioFailure] = []
    private var timestamps: [UInt64] = []
    private let accepted: Bool
    init(accepted: Bool = true) { self.accepted = accepted }
    func receive(_ frame: DesktopAudioFrame) -> Bool {
        lock.withLock { timestamps.append(frame.hostTimeNanoseconds) }
        return accepted
    }
    func failed(_ reason: DesktopAudioFailure) { lock.withLock { failures.append(reason) } }
    var errors: [DesktopAudioFailure] { lock.withLock { failures } }
    var times: [UInt64] { lock.withLock { timestamps } }
}

@Test func boundedDeliveryClearsAcceptedNativeSamples() async throws {
    let consent = ConsentedFixture(), sink = Sink(), gate = AudioDelivery(sink: sink, onFailure: { _ in })
    let a = try consent.frame(1), b = try consent.frame(2)
    gate.offer(a); gate.offer(b); await gate.drain(); gate.freeze()
    #expect(sink.times == [1, 2]); #expect(a.isClear && b.isClear); #expect(sink.errors.isEmpty)
}

@Test func boundedQueueFailsOnceInsteadOfDroppingOrGrowing() async throws {
    let consent = ConsentedFixture(), sink = Sink(), queue = DispatchQueue(label: "synthetic.suspended")
    queue.suspend()
    let gate = AudioDelivery(sink: sink, queue: queue, onFailure: { _ in })
    let frames = try (1...7).map { try consent.frame(UInt64($0)) }
    for frame in frames { gate.offer(frame) }
    queue.resume(); await gate.drain()
    #expect(sink.errors == [.bufferOverflow]); #expect(sink.times.isEmpty)
    let cleared = frames.allSatisfy { $0.isClear }
    #expect(cleared)
}

@Test func consumerFailureIsTerminalAndClearsLaterAudio() async throws {
    let consent = ConsentedFixture(), sink = Sink(accepted: false)
    let gate = AudioDelivery(sink: sink, onFailure: { _ in })
    let a = try consent.frame(1), b = try consent.frame(2)
    gate.offer(a); await gate.drain(); gate.offer(b); await gate.drain()
    #expect(sink.errors == [.sinkRejected]); #expect(sink.times == [1]); #expect(a.isClear && b.isClear)
}

@Test func freezeAndDrainClearQueuedAndSubsequentFrames() async throws {
    let consent = ConsentedFixture(), sink = Sink(), queue = DispatchQueue(label: "synthetic.freeze")
    queue.suspend()
    let gate = AudioDelivery(sink: sink, queue: queue, onFailure: { _ in })
    let a = try consent.frame(1), b = try consent.frame(2)
    gate.offer(a); gate.freeze(); gate.offer(b); queue.resume(); await gate.drain()
    #expect(sink.times.isEmpty); #expect(sink.errors.isEmpty); #expect(a.isClear && b.isClear)
}

@Test func normalStopDrainsAcceptedFramesAndRejectsLaterInput() async throws {
    let consent = ConsentedFixture(), sink = Sink(), queue = DispatchQueue(label: "synthetic.normal-stop")
    queue.suspend()
    let gate = AudioDelivery(sink: sink, queue: queue, onFailure: { _ in })
    let a = try consent.frame(1), b = try consent.frame(2), late = try consent.frame(3)
    gate.offer(a); gate.offer(b); gate.seal(); gate.offer(late)
    queue.resume(); await gate.drain()
    #expect(sink.times == [1, 2]); #expect(sink.errors.isEmpty)
    #expect(a.isClear && b.isClear && late.isClear)
}

@Test func failedNormalStopDrainDiscardsRemainingFramesAndReportsOnce() async throws {
    let consent = ConsentedFixture(), sink = Sink(accepted: false), queue = DispatchQueue(label: "synthetic.failed-drain")
    queue.suspend()
    let gate = AudioDelivery(sink: sink, queue: queue, onFailure: { _ in })
    let a = try consent.frame(1), b = try consent.frame(2)
    gate.offer(a); gate.offer(b); gate.seal(); queue.resume(); await gate.drain()
    #expect(sink.times == [1]); #expect(sink.errors == [.sinkRejected]); #expect(a.isClear && b.isClear)
}

@Test func sourceTimestampsAreIndependentAndNeverSilentlyReordered() async throws {
    let consent = ConsentedFixture(), sink = Sink(), gate = AudioDelivery(sink: sink, onFailure: { _ in })
    let microphone = try consent.frame(100), system = try consent.frame(100, channel: .systemAudio)
    gate.offer(microphone); gate.offer(system); await gate.drain()
    let repeated = try consent.frame(100)
    gate.offer(repeated); await gate.drain()
    #expect(sink.times == [100, 100]); #expect(sink.errors == [.invalidAudio]); #expect(repeated.isClear)
}

@Test func invalidNativeFramesAreRejectedBeforeDelivery() throws {
    let consent = ConsentedFixture()
    #expect(consent.allPartiesAgreed)
    for value: Float in [.nan, .infinity, -.infinity] {
        #expect(throws: DesktopAudioFailure.invalidAudio) {
            try DesktopAudioFrame(channel: .microphone, sampleRate: 48_000, channels: 1,
                                  hostTimeNanoseconds: 1, samples: [value])
        }
    }
    #expect(throws: DesktopAudioFailure.invalidAudio) {
        try DesktopAudioFrame(channel: .systemAudio, sampleRate: 48_000, channels: 2,
                              hostTimeNanoseconds: 1, samples: [0])
    }
    #expect(throws: DesktopAudioFailure.invalidAudio) {
        try DesktopAudioFrame(channel: .microphone, sampleRate: 48_000, channels: 1,
                              hostTimeNanoseconds: 1, samples: Array(repeating: 0, count: 8193))
    }
}

@available(macOS 14.2, *)
@Test func actualAVFoundationMemoryConversionPreservesChannelsAndClock() throws {
    let consent = ConsentedFixture()
    #expect(consent.allPartiesAgreed)
    for interleaved in [false, true] {
        let format = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000,
                                              channels: 2, interleaved: interleaved))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
        buffer.frameLength = 4
        let data = try #require(buffer.floatChannelData)
        for i in 0..<4 {
            if interleaved { data[0][i * 2] = 0.125; data[0][i * 2 + 1] = -0.25 }
            else { data[0][i] = 0.125; data[1][i] = -0.25 }
        }
        let frame = try AudioOutput.frame(buffer, channel: .systemAudio, time: CMTime(value: 3, timescale: 2), sourceSamplePosition: 72_000)
        #expect(frame.hostTimeNanoseconds == 1_500_000_000)
        #expect(frame.sourceSamplePosition == 72_000)
        #expect(frame.sampleRate == 48_000 && frame.channels == 2 && frame.frameCount == 4)
        frame.withSamples { samples in
            #expect(Array(samples) == [0.125, -0.25, 0.125, -0.25, 0.125, -0.25, 0.125, -0.25])
        }
        frame.clear(); #expect(frame.isClear)
    }
}

@available(macOS 14.2, *)
@Test func disabledProducerDoesNotQueryOrStartCapture() async throws {
    let source = MacMeetingAudio()
    let selection = try MeetingAudioSelection(application: .zoom, processID: 123, windowID: 456)
    await #expect(throws: DesktopAudioFailure.unavailable) {
        try await source.start(selection: selection, maximumDurationSeconds: 30, sink: Sink())
    }
    try await source.stop()
    await #expect(throws: DesktopAudioFailure.unavailable) {
        try await source.start(selection: selection, maximumDurationSeconds: 30, sink: Sink())
    }
}

@Test func selectionRequiresExplicitWindowAndProcess() {
    #expect(throws: DesktopAudioFailure.selectionChanged) {
        try MeetingAudioSelection(application: .chrome, processID: 0, windowID: 1)
    }
    #expect(throws: DesktopAudioFailure.selectionChanged) {
        try MeetingAudioSelection(application: .zoom, processID: 1, windowID: 0)
    }
}

@available(macOS 14.2, *)
@Test func stopBeforeStartPreventsAnyLateCapture() async throws {
    let source = MacMeetingAudio(enabled: true)
    try await source.stop()
    let selection = try MeetingAudioSelection(application: .chrome, processID: 123, windowID: 456)
    await #expect(throws: DesktopAudioFailure.unavailable) {
        try await source.start(selection: selection, maximumDurationSeconds: 30, sink: Sink())
    }
}
