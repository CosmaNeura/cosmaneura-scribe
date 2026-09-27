import Foundation
import Testing
@testable import ScribeDesktopAudio

/// All input is generated after this explicit invented, all-parties consent.
/// No permission query, capture source, credential, file audio or network call.
private struct MixerFixture {
    let consentID = UUID()
    let allPartiesAgreed = true
    let origin: UInt64 = 1_000_000_000
    func frame(_ channel: DesktopAudioChannel, offset: UInt64, position: Int64,
               rate: Int = 48_000, channels: Int = 1, samples: [Float]) throws -> DesktopAudioFrame {
        precondition(allPartiesAgreed)
        return try DesktopAudioFrame(channel: channel, sampleRate: rate, channels: channels,
            hostTimeNanoseconds: origin + offset, sourceSamplePosition: position, samples: samples)
    }
}

private final class PCMSink: DesktopPCMSink, @unchecked Sendable {
    let lock = NSLock()
    var starts: [DesktopPCMStart] = []
    var packets: [DesktopPCMPacket] = []
    var values: [Int16] = []
    var errors: [DesktopAudioFailure] = []
    let acceptStart: Bool
    let acceptPacket: Bool
    init(acceptStart: Bool = true, acceptPacket: Bool = true) {
        self.acceptStart = acceptStart; self.acceptPacket = acceptPacket
    }
    func started(_ start: DesktopPCMStart) -> Bool {
        lock.withLock { starts.append(start) }; return acceptStart
    }
    func receive(_ packet: DesktopPCMPacket) -> Bool {
        lock.withLock { packets.append(packet); packet.withSamples { values.append(contentsOf: $0) } }
        return acceptPacket
    }
    func failed(_ reason: DesktopAudioFailure) { lock.withLock { errors.append(reason) } }
}

@Test func renewingMixerPreservesClockSamplesAndContiguousOutputPositions() throws {
    let fixture = MixerFixture(), sink = PCMSink()
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 480, hardMaximumOutputFrames: 960, sink: sink)
    for tick in 0..<6 {
        if tick == 2 { try mixer.extend(maximumOutputFrames: 960) }
        for channel in [DesktopAudioChannel.microphone, .systemAudio] {
            #expect(mixer.receive(try fixture.frame(channel, offset: UInt64(tick * 10_000_000), position: Int64(tick * 160),
                rate: 16_000, samples: Array(repeating: channel == .microphone ? 0.5 : 0.25, count: 160))))
        }
    }
    #expect(throws: DesktopAudioFailure.self) { try mixer.extend(maximumOutputFrames: 961) }
    #expect(throws: DesktopAudioFailure.self) { try mixer.extend(maximumOutputFrames: 959) }
    let result = try mixer.finish()
    #expect(result.outputFrames == 960 && sink.starts.count == 1)
    #expect(sink.values == Array(repeating: 12_288, count: 960))
    var position = 0
    for packet in sink.packets { #expect(packet.firstFrame == position); position += packet.frameCount }
    #expect(position == 960 && sink.errors.isEmpty)
    #expect(throws: DesktopAudioFailure.self) { try mixer.extend(maximumOutputFrames: 960) }
    let legacy = try AlignedMeetingPCM(maximumOutputFrames: 160, sink: PCMSink())
    #expect(throws: DesktopAudioFailure.self) { try legacy.extend(maximumOutputFrames: 161) }
}

@Test func actualNativeDeliveryMixesStereoAndDifferentRatesAtCommonStart() async throws {
    let fixture = MixerFixture(), sink = PCMSink()
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
    let delivery = AudioDelivery(sink: mixer, onFailure: { _ in })
    let mic = Array(repeating: [Float(1), Float(0)], count: 720).flatMap { $0 }
    let system = Array(repeating: Float(-0.25), count: 240)
    for i in 0..<3 {
        delivery.offer(try fixture.frame(.microphone, offset: UInt64(i * 15_000_000),
            position: Int64(i * 720), channels: 2, samples: mic))
        delivery.offer(try fixture.frame(.systemAudio, offset: UInt64(5_000_000 + i * 15_000_000),
            position: Int64(i * 240), rate: 16_000, samples: system))
        await delivery.drain()
    }
    delivery.freeze(); await delivery.drain()
    let result = try mixer.finish()
    #expect(sink.starts.count == 1)
    #expect(result.start.hostTimeNanoseconds == fixture.origin + 5_000_000)
    #expect(result.start.microphonePrerollNanoseconds == 5_000_000)
    #expect(result.endHostTimeNanoseconds == fixture.origin + 45_000_000)
    #expect(result.systemTailNanoseconds == 5_000_000)
    #expect(result.microphoneTailNanoseconds == 0)
    #expect(result.outputFrames == 640)
    #expect(sink.values == Array(repeating: 4096, count: 640))
    #expect(sink.packets.allSatisfy { $0.isClear })
    #expect(sink.errors.isEmpty)
}

@Test func commonClockCorrectsDriftWithoutAccumulatingNominalRateError() throws {
    let fixture = MixerFixture(), sink = PCMSink()
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 20_000, sink: sink)
    let data = Array(repeating: Float(0.5), count: 480)
    // Both source clocks are continuous, but microphone runs 1000 ppm slower.
    for i in 0..<100 {
        #expect(mixer.receive(try fixture.frame(.microphone, offset: UInt64(i * 10_010_000),
            position: Int64(i * 480), samples: data)))
        #expect(mixer.receive(try fixture.frame(.systemAudio, offset: UInt64(i * 10_000_000),
            position: Int64(i * 480), samples: data)))
    }
    let result = try mixer.finish()
    #expect(result.outputFrames == 16_000)
    #expect(result.microphoneTailNanoseconds == 1_000_000)
    let constantPreserved = sink.values.count == 16_000 && sink.values.allSatisfy { $0 == 16_384 }
    #expect(constantPreserved)
    #expect(sink.errors.isEmpty)
}

@Test func missingSourceSamplesAreNotReinterpretedAsClockDriftOrSilence() throws {
    let fixture = MixerFixture(), sink = PCMSink()
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
    let data = Array(repeating: Float(0.25), count: 1024)
    #expect(mixer.receive(try fixture.frame(.microphone, offset: 0, position: 0, samples: data)))
    // A single skipped source sample is inside the clock-slope ceiling, but
    // source position continuity must still reject it.
    #expect(!mixer.receive(try fixture.frame(.microphone, offset: 21_354_167, position: 1025, samples: data)))
    #expect(sink.errors == [.clockDiscontinuity]); #expect(sink.values.isEmpty)
    #expect(!mixer.receive(try fixture.frame(.systemAudio, offset: 0, position: 0, samples: data)))
    #expect(sink.errors.count == 1)
}

@Test func excessiveClockJumpAndFormatChangeFailBeforeOutput() throws {
    let fixture = MixerFixture()
    for change in [false, true] {
        let sink = PCMSink(), data = Array(repeating: Float(0), count: 480)
        let mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
        #expect(mixer.receive(try fixture.frame(.microphone, offset: 0, position: 0, samples: data)))
        #expect(!mixer.receive(try fixture.frame(.microphone, offset: change ? 10_000_000 : 11_000_000,
            position: 480, rate: change ? 44_100 : 48_000, samples: data)))
        #expect(sink.errors == [.clockDiscontinuity]); #expect(sink.starts.isEmpty)
    }
}

@Test func absentSystemSourceHasBoundedRetentionAndNoMicrophoneFallback() throws {
    let fixture = MixerFixture(), sink = PCMSink()
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
    let data = Array(repeating: Float(0.5), count: 480)
    for i in 0..<85 {
        #expect(mixer.receive(try fixture.frame(.microphone, offset: UInt64(i * 10_000_000),
            position: Int64(i * 480), samples: data)))
    }
    #expect(!mixer.receive(try fixture.frame(.microphone, offset: 850_000_000, position: 40_800, samples: data)))
    #expect(sink.errors == [.bufferOverflow]); #expect(sink.values.isEmpty); #expect(sink.starts.isEmpty)
}

@Test func delayedSystemStartupRetainsBoundedPrerollAndReportsActualCoverage() throws {
    let fixture = MixerFixture(), sink = PCMSink()
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
    let data = Array(repeating: Float(0.5), count: 1024)
    for i in 0..<12 {
        #expect(mixer.receive(try fixture.frame(.microphone,
            offset: UInt64((Double(i * 1024) / 48_000 * 1_000_000_000).rounded()),
            position: Int64(i * 1024), samples: data)))
    }
    #expect(sink.starts.isEmpty); #expect(sink.values.isEmpty)
    for i in 0..<2 {
        #expect(mixer.receive(try fixture.frame(.systemAudio,
            offset: 200_000_000 + UInt64((Double(i * 1024) / 48_000 * 1_000_000_000).rounded()),
            position: Int64(i * 1024), samples: data)))
    }
    let result = try mixer.finish()
    #expect(sink.errors.isEmpty); #expect(sink.starts.count == 1)
    #expect(result.start.microphonePrerollNanoseconds == 200_000_000)
    #expect(result.start.systemPrerollNanoseconds == 0)
    #expect(result.outputFrames == 683)
    #expect(sink.values.allSatisfy { $0 == 16_384 })
}

@Test func disparateCallbackSizesPreserveBothSourcesWithoutOverflowOrMissingSamples() throws {
    let fixture = MixerFixture()
    for largeChannel in [DesktopAudioChannel.microphone, .systemAudio] {
        let smallChannel: DesktopAudioChannel = largeChannel == .microphone ? .systemAudio : .microphone
        let sink = PCMSink(), mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
        for i in 0..<24 {
            let position = i * 1024
            let offset = UInt64((Double(position) / 48_000 * 1_000_000_000).rounded())
            if i % 8 == 0 {
                #expect(mixer.receive(try fixture.frame(largeChannel, offset: offset,
                    position: Int64(position), samples: Array(repeating: Float(0.5), count: 8192))))
            }
            #expect(mixer.receive(try fixture.frame(smallChannel, offset: offset,
                position: Int64(position), samples: Array(repeating: Float(0.5), count: 1024))))
        }
        let result = try mixer.finish()
        #expect(sink.errors.isEmpty); #expect(result.outputFrames == 8192)
        #expect(sink.values.count == 8192); #expect(sink.values.allSatisfy { $0 == 16_384 })
    }
}

@Test func absentSourceIsAlsoBoundedByElapsedAudioAndMetadata() throws {
    let fixture = MixerFixture()
    for count in [1, 480] {
        let sink = PCMSink(), mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
        let accepted = count == 1 ? 128 : 66
        for i in 0..<accepted {
            #expect(mixer.receive(try fixture.frame(.microphone, offset: UInt64(i * count * 62_500),
                position: Int64(i * count), rate: 16_000, samples: Array(repeating: Float(0.5), count: count))))
        }
        #expect(!mixer.receive(try fixture.frame(.microphone, offset: UInt64(accepted * count * 62_500),
            position: Int64(accepted * count), rate: 16_000, samples: Array(repeating: Float(0.5), count: count))))
        #expect(sink.errors == [.bufferOverflow]); #expect(sink.starts.isEmpty); #expect(sink.values.isEmpty)
    }
}

@Test func largestBuffersAtLowestSupportedRateCanEstablishBothClockAnchors() throws {
    let fixture = MixerFixture(), sink = PCMSink()
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 40_000, sink: sink)
    for i in 0..<3 {
        for channel in [DesktopAudioChannel.microphone, .systemAudio] {
            #expect(mixer.receive(try fixture.frame(channel, offset: UInt64(i * 512_000_000),
                position: Int64(i * 8192), rate: 16_000, samples: Array(repeating: Float(0.5), count: 8192))))
        }
    }
    let result = try mixer.finish()
    #expect(sink.errors.isEmpty); #expect(result.outputFrames == 24_576)
    #expect(sink.values.count == 24_576); #expect(sink.values.allSatisfy { $0 == 16_384 })
}

@Test func sourceWithoutClockPositionCannotEnterAlignedConversion() throws {
    let consent = MixerFixture(), sink = PCMSink()
    #expect(consent.allPartiesAgreed)
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 100, sink: sink)
    let frame = try DesktopAudioFrame(channel: .microphone, sampleRate: 48_000, channels: 1,
        hostTimeNanoseconds: 1, samples: [0])
    #expect(!mixer.receive(frame)); #expect(sink.errors == [.clockDiscontinuity])
}

@Test func rejectedStartOrPacketNeverEmitsFurtherAudio() throws {
    let fixture = MixerFixture(), data = Array(repeating: Float(1), count: 480)
    for rejectStart in [false, true] {
        let sink = PCMSink(acceptStart: !rejectStart, acceptPacket: false)
        let mixer = try AlignedMeetingPCM(maximumOutputFrames: 16_000, sink: sink)
        for channel: DesktopAudioChannel in [.microphone, .systemAudio] {
            #expect(mixer.receive(try fixture.frame(channel, offset: 0, position: 0, samples: data)))
        }
        #expect(mixer.receive(try fixture.frame(.microphone, offset: 10_000_000, position: 480, samples: data)))
        #expect(!mixer.receive(try fixture.frame(.systemAudio, offset: 10_000_000, position: 480, samples: data)))
        #expect(sink.errors == [.sinkRejected]); #expect(sink.packets.count == (rejectStart ? 0 : 1))
        #expect(sink.packets.allSatisfy { $0.isClear })
        #expect(throws: DesktopAudioFailure.invalidAudio) { try mixer.finish() }
    }
}

@Test func finalPartialPeriodIsEmittedOnceWithoutPaddingAndDiscardEmitsNothing() throws {
    let fixture = MixerFixture()
    for discard in [false, true] {
        let sink = PCMSink(), mixer = try AlignedMeetingPCM(maximumOutputFrames: 100, sink: sink)
        for i in 0..<2 {
            for channel: DesktopAudioChannel in [.microphone, .systemAudio] {
                #expect(mixer.receive(try fixture.frame(channel, offset: UInt64(i * 20_833),
                    position: Int64(i), samples: [-1])))
            }
        }
        #expect(sink.values.isEmpty)
        if discard { mixer.discard(); #expect(sink.values.isEmpty) }
        else {
            let completion = try mixer.finish()
            #expect(completion.outputFrames == 1); #expect(sink.values == [-32_768])
            #expect(completion.endHostTimeNanoseconds == fixture.origin + 41_666)
        }
        #expect(throws: DesktopAudioFailure.invalidAudio) { try mixer.finish() }
    }
}

@Test func captureBoundRejectsExtraOutputInsteadOfExtendingAuthority() throws {
    let fixture = MixerFixture(), sink = PCMSink(), data = Array(repeating: Float(0.5), count: 480)
    let mixer = try AlignedMeetingPCM(maximumOutputFrames: 160, sink: sink)
    for i in 0..<3 {
        for channel: DesktopAudioChannel in [.microphone, .systemAudio] {
            let accepted = mixer.receive(try fixture.frame(channel, offset: UInt64(i * 10_000_000),
                position: Int64(i * 480), samples: data))
            #expect(accepted == !(i == 2 && channel == .systemAudio))
        }
    }
    #expect(sink.values.count == 160); #expect(sink.errors == [.windowExpired])
}

@Test func nanosecondClockAnchorsMatchExactRationalGoldenBytes() throws {
    let fixture = MixerFixture()
    #expect(fixture.allPartiesAgreed)
    let url = try #require(Bundle.module.url(forResource: "host-aligned-area-v1", withExtension: "json", subdirectory: "Fixtures"))
    let json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let hex = try #require(json["input_pcm_f32le_hex"] as? String)
    #expect(json["conversion_version"] as? String == AlignedMeetingPCM.conversionVersion)
    let bytes = stride(from: 0, to: hex.count, by: 2).map { i -> UInt8 in
        let begin = hex.index(hex.startIndex, offsetBy: i)
        return UInt8(hex[begin..<hex.index(begin, offsetBy: 2)], radix: 16)!
    }
    let input = stride(from: 0, to: bytes.count, by: 4).map { i -> Float in
        Float(bitPattern: UInt32(bytes[i]) | UInt32(bytes[i + 1]) << 8 |
              UInt32(bytes[i + 2]) << 16 | UInt32(bytes[i + 3]) << 24)
    }
    for entry in try #require(json["cases"] as? [[String: Any]]) {
        let counts = try #require(entry["frame_counts"] as? [Int])
        let stamps = try #require(entry["host_offsets_ns"] as? [UInt64])
        let expected = try #require(entry["expected_pcm_s16le_hex"] as? String)
        let end = try #require(entry["expected_end_offset_ns"] as? UInt64)
        let sink = PCMSink(), mixer = try AlignedMeetingPCM(maximumOutputFrames: 100, sink: sink)
        var offset = 0
        for (index, count) in counts.enumerated() {
            for channel: DesktopAudioChannel in [.microphone, .systemAudio] {
                #expect(mixer.receive(try fixture.frame(channel,
                    offset: stamps[index],
                    position: Int64(offset), rate: 44_100, samples: Array(input[offset..<(offset + count)]))))
            }
            offset += count
        }
        let completion = try mixer.finish()
        #expect(completion.endHostTimeNanoseconds == fixture.origin + end)
        let actual = sink.values.flatMap { value -> [UInt8] in
            let raw = UInt16(bitPattern: value); return [UInt8(raw & 255), UInt8(raw >> 8)]
        }.map { String(format: "%02x", $0) }.joined()
        #expect(actual == expected)
    }
}

@Test func offsetWaveformsUseSharedHostTimeInsteadOfPacketArrivalOrder() throws {
    let fixture = MixerFixture()
    var results: [[Int16]] = []
    for reverse in [false, true] {
        let sink = PCMSink(), mixer = try AlignedMeetingPCM(maximumOutputFrames: 100, sink: sink)
        for i in 0..<3 {
            let microphone = try fixture.frame(.microphone, offset: UInt64(i * 250_000), position: Int64(i * 4),
                rate: 16_000, samples: [1, 0, -1, 0])
            let system = try fixture.frame(.systemAudio, offset: UInt64(62_500 + i * 250_000), position: Int64(i * 4),
                rate: 16_000, samples: [1, 0, -1, 0])
            for frame in reverse ? [system, microphone] : [microphone, system] { #expect(mixer.receive(frame)) }
        }
        let result = try mixer.finish()
        #expect(result.start.hostTimeNanoseconds == fixture.origin + 62_500)
        #expect(result.outputFrames == 11)
        results.append(sink.values)
    }
    #expect(results[0] == [16384, -16384, -16384, 16384, 16384, -16384, -16384, 16384, 16384, -16384, -16384])
    #expect(results[0] == results[1])
}
