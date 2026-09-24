import Foundation

/// Main/native-process PCM only. The receiving encryption pipeline consumes or
/// copies synchronously; samples clear after the callback, even on rejection.
public final class DesktopPCMPacket: @unchecked Sendable {
    public let firstFrame: Int
    public let frameCount: Int
    private let lock = NSLock()
    private var samples: [Int16]
    init(firstFrame: Int, samples: [Int16]) {
        self.firstFrame = firstFrame; self.frameCount = samples.count; self.samples = samples
    }
    deinit { clear() }
    public func withSamples<T>(_ body: (UnsafeBufferPointer<Int16>) throws -> T) rethrows -> T {
        try lock.withLock { try samples.withUnsafeBufferPointer(body) }
    }
    public func clear() { lock.withLock { for i in samples.indices { samples[i] = 0 } } }
    var isClear: Bool { lock.withLock { samples.allSatisfy { $0 == 0 } } }
}

public struct DesktopPCMStart: Sendable, Equatable {
    public let hostTimeNanoseconds: UInt64
    /// Authorized startup audio before both sources cover the same interval.
    /// The host remains in "starting" until it accepts this boundary.
    public let microphonePrerollNanoseconds: UInt64
    public let systemPrerollNanoseconds: UInt64
}

public struct DesktopPCMCompletion: Sendable, Equatable {
    public let start: DesktopPCMStart
    public let endHostTimeNanoseconds: UInt64
    public let outputFrames: Int
    /// Unpaired tails are disclosed, never padded with invented silence. The
    /// host must retain these in its capture outcome, not claim full coverage.
    public let microphoneTailNanoseconds: UInt64
    public let systemTailNanoseconds: UInt64
}

public protocol DesktopPCMSink: Sendable {
    /// Called before the first PCM packet. The native owner must publish the
    /// actual recorded start and may reject it; no renderer audio is involved.
    func started(_ start: DesktopPCMStart) -> Bool
    func receive(_ packet: DesktopPCMPacket) -> Bool
    func failed(_ reason: DesktopAudioFailure)
}

/// Mixed mono, signed PCM16, 16 kHz. Clock alignment is a separate version from
/// the existing nominal-rate area-weighted-v1 resampler: packet intervals use
/// adjacent observed host anchors, with source-clock continuity checked first.
/// Stereo becomes the mean of its clamped channels; sources have equal weight.
/// No AGC, echo cancellation, silence insertion, retry or source substitution.
public final class AlignedMeetingPCM: DesktopAudioSink, @unchecked Sendable {
    public static let conversionVersion = "host-aligned-area-v1"
    public static let sampleRate = 16_000
    private let lock = NSLock()
    private let sink: any DesktopPCMSink
    private var core: MeetingPCMCore
    private var terminal = false
    private var delivering = false

    /// The trusted host derives this bound from current Core capture authority.
    /// Numeric validation alone grants no capture permission. No source starts
    /// here. Native delivery must serialize receive/finish/discard; failed may
    /// arrive concurrently. A concurrent/reentrant delivery is a terminal error.
    public init(maximumOutputFrames: Int, sink: any DesktopPCMSink) throws {
        guard (1...1_382_400_000).contains(maximumOutputFrames) else { throw DesktopAudioFailure.invalidAudio }
        self.sink = sink; self.core = MeetingPCMCore(maximumOutputFrames: maximumOutputFrames)
    }

    public func receive(_ frame: DesktopAudioFrame) -> Bool {
        do {
            let batch = try lock.withLock {
                guard !terminal, !delivering else { throw DesktopAudioFailure.invalidAudio }
                delivering = true
                return try core.push(frame)
            }
            defer { lock.withLock { delivering = false } }
            return deliver(batch)
        } catch {
            failed((error as? DesktopAudioFailure) ?? .invalidAudio)
            return false
        }
    }

    /// Only after the OS source has stopped and its delivery queue has drained.
    /// Final packet duration uses the last observed per-source clock slope. Its
    /// common covered tail is emitted once, with no zero padding. A failed or
    /// interrupted source uses discard instead, preserving already encrypted work.
    public func finish() throws -> DesktopPCMCompletion {
        do {
            let (batch, completion) = try lock.withLock {
                guard !terminal, !delivering else { throw DesktopAudioFailure.invalidAudio }
                delivering = true
                return try core.finish()
            }
            defer { lock.withLock { delivering = false } }
            guard deliver(batch) else { throw DesktopAudioFailure.sinkRejected }
            try lock.withLock {
                guard !terminal else { throw DesktopAudioFailure.invalidAudio }
                terminal = true; core.clear()
            }
            return completion
        } catch {
            failed((error as? DesktopAudioFailure) ?? .invalidAudio)
            throw (error as? DesktopAudioFailure) ?? .invalidAudio
        }
    }

    public func discard() { lock.withLock { terminal = true; core.clear() } }

    public func failed(_ reason: DesktopAudioFailure) {
        let report = lock.withLock {
            guard !terminal else { return false }
            terminal = true; core.clear(); return true
        }
        if report { sink.failed(reason) }
    }

    private func deliver(_ batch: PCMBatch) -> Bool {
        defer { batch.packets.forEach { $0.clear() } }
        if let start = batch.start {
            guard !lock.withLock({ terminal }), sink.started(start) else { failed(.sinkRejected); return false }
        }
        for packet in batch.packets {
            guard !lock.withLock({ terminal }), sink.receive(packet) else { failed(.sinkRejected); return false }
        }
        return !lock.withLock { terminal }
    }
}

private struct PCMBatch {
    var start: DesktopPCMStart?
    var packets: [DesktopPCMPacket] = []
}

private final class MonoFrame {
    let start: UInt64
    let position: Int64
    let rate: Int
    let channels: Int
    let count: Int
    var samples: [Double]
    init(_ frame: DesktopAudioFrame) throws {
        guard let position = frame.sourceSamplePosition else { throw DesktopAudioFailure.clockDiscontinuity }
        self.start = frame.hostTimeNanoseconds; self.position = position
        let count = frame.frameCount
        self.rate = frame.sampleRate; self.channels = frame.channels; self.count = count
        self.samples = frame.withSamples { input in
            (0..<count).map { i in
                (0..<frame.channels).reduce(0.0) { sum, c in
                    sum + max(-1, min(1, Double(input[i * frame.channels + c])))
                } / Double(frame.channels)
            }
        }
    }
    deinit { clear() }
    func clear() { for i in samples.indices { samples[i] = 0 } }
}

private struct ClockSpan {
    let frame: MonoFrame
    let end: UInt64
}

private struct ClockTrack {
    // Bound retained audio independently of OS callback size/cadence. The
    // sample ceiling matches the former five maximum-size (8,192) buffers.
    // Separate metadata/time ceilings also bound tiny or slow-rate callbacks.
    private static let maximumRetainedSamples = 40_960
    private static let maximumRetainedFrames = 128
    private static let maximumRetainedNanoseconds = 2_000_000_000.0
    var pending: MonoFrame?
    var spans: [ClockSpan] = []
    var firstStart: UInt64?
    var nanosecondsPerFrame: Double?

    mutating func push(_ frame: MonoFrame) throws {
        let retainedSamples = spans.reduce(pending?.count ?? 0) { $0 + $1.frame.count }
        let retainedFrames = spans.count + (pending == nil ? 0 : 1)
        guard frame.count <= Self.maximumRetainedSamples - retainedSamples,
              retainedFrames < Self.maximumRetainedFrames else { throw DesktopAudioFailure.bufferOverflow }
        let oldest = spans.first?.frame.start ?? pending?.start ?? frame.start
        guard frame.start >= oldest else { throw DesktopAudioFailure.clockDiscontinuity }
        let retainedDuration = Double(frame.start - oldest) + Double(frame.count) * 1_000_000_000 / Double(frame.rate)
        guard retainedDuration <= Self.maximumRetainedNanoseconds else { throw DesktopAudioFailure.bufferOverflow }
        if let previous = pending {
            let (nextPosition, overflow) = previous.position.addingReportingOverflow(Int64(previous.count))
            guard !overflow, frame.position == nextPosition, frame.rate == previous.rate,
                  frame.channels == previous.channels, frame.start > previous.start else {
                throw DesktopAudioFailure.clockDiscontinuity
            }
            let period = Double(frame.start - previous.start) / Double(previous.count)
            let ratio = period * Double(frame.rate) / 1_000_000_000
            // This is a rejection ceiling, not a claim about hardware accuracy.
            // A lost source sample still fails the independent position check.
            guard (0.995...1.005).contains(ratio) else { throw DesktopAudioFailure.clockDiscontinuity }
            spans.append(ClockSpan(frame: previous, end: frame.start))
            nanosecondsPerFrame = period
        } else { firstStart = frame.start }
        pending = frame
    }

    mutating func finish() throws {
        guard let pending, let period = nanosecondsPerFrame else { throw DesktopAudioFailure.clockDiscontinuity }
        let duration = UInt64((Double(pending.count) * period).rounded())
        let (end, overflow) = pending.start.addingReportingOverflow(duration)
        guard !overflow, end > pending.start else { throw DesktopAudioFailure.clockDiscontinuity }
        spans.append(ClockSpan(frame: pending, end: end)); self.pending = nil
    }

    /// Integrate only supplied samples. All consecutive spans share the same
    /// observed boundary, and a missing span fails instead of becoming silence.
    func area(from: UInt64, to: UInt64) throws -> Double {
        var cursor = from
        var total = 0.0
        for span in spans where span.end > cursor && span.frame.start < to {
            guard span.frame.start <= cursor else { throw DesktopAudioFailure.clockDiscontinuity }
            let frame = span.frame
            let stop = min(span.end, to)
            // Integer rational overlap avoids cumulative floating-point edge
            // error (including inconsistent PCM rounding for constant input).
            let duration = Int64(span.end - frame.start)
            let count = Int64(frame.count)
            let low = Int64(cursor - frame.start) * count
            let high = Int64(stop - frame.start) * count
            var weighted = 0.0
            for i in Int(low / duration)..<min(frame.count, Int((high + duration - 1) / duration)) {
                let overlap = min(high, Int64(i + 1) * duration) - max(low, Int64(i) * duration)
                weighted += frame.samples[i] * Double(overlap)
            }
            total += weighted / Double(count)
            cursor = stop
            if cursor == to { return total }
        }
        throw DesktopAudioFailure.clockDiscontinuity
    }

    mutating func consume(through time: UInt64) {
        while let first = spans.first, first.end <= time {
            first.frame.clear(); spans.removeFirst()
        }
    }
    mutating func clear() {
        pending?.clear(); pending = nil
        spans.forEach { $0.frame.clear() }; spans.removeAll()
    }
}

private struct MeetingPCMCore {
    let maximumOutputFrames: Int
    var microphone = ClockTrack()
    var system = ClockTrack()
    var start: DesktopPCMStart?
    var cursor: UInt64 = 0
    var outputFrames = 0

    mutating func push(_ frame: DesktopAudioFrame) throws -> PCMBatch {
        let mono = try MonoFrame(frame)
        switch frame.channel {
        case .microphone: try microphone.push(mono)
        case .systemAudio: try system.push(mono)
        }
        return try produce(final: false)
    }

    mutating func finish() throws -> (PCMBatch, DesktopPCMCompletion) {
        try microphone.finish(); try system.finish()
        guard let microphoneEnd = microphone.spans.last?.end, let systemEnd = system.spans.last?.end else {
            throw DesktopAudioFailure.clockDiscontinuity
        }
        let batch = try produce(final: true)
        guard let start, outputFrames > 0 else { throw DesktopAudioFailure.clockDiscontinuity }
        let end = min(microphoneEnd, systemEnd)
        return (batch, DesktopPCMCompletion(start: start, endHostTimeNanoseconds: end,
            outputFrames: outputFrames, microphoneTailNanoseconds: microphoneEnd - end,
            systemTailNanoseconds: systemEnd - end))
    }

    mutating func produce(final: Bool) throws -> PCMBatch {
        var batch = PCMBatch()
        guard let microphoneEnd = microphone.spans.last?.end, let systemEnd = system.spans.last?.end,
              let microphoneStart = microphone.firstStart, let systemStart = system.firstStart else { return batch }
        if start == nil {
            let origin = max(microphoneStart, systemStart)
            guard origin < min(microphoneEnd, systemEnd) else { return batch }
            let boundary = DesktopPCMStart(hostTimeNanoseconds: origin,
                microphonePrerollNanoseconds: origin - microphoneStart,
                systemPrerollNanoseconds: origin - systemStart)
            start = boundary; cursor = origin; batch.start = boundary
        }
        let end = min(microphoneEnd, systemEnd)
        var samples: [Int16] = []
        var packetStart = outputFrames
        defer { for i in samples.indices { samples[i] = 0 } }
        while cursor < end {
            let duration = min(UInt64(62_500), end - cursor)
            if duration < 62_500 && !final { break }
            guard outputFrames < maximumOutputFrames else { throw DesktopAudioFailure.windowExpired }
            let next = cursor + duration
            let mean = (try microphone.area(from: cursor, to: next) + system.area(from: cursor, to: next))
                / (2 * Double(duration))
            let bounded = max(-1, min(1, mean))
            samples.append(Int16(floor(bounded * (bounded < 0 ? 32_768 : 32_767) + 0.5)))
            outputFrames += 1; cursor = next
            microphone.consume(through: cursor); system.consume(through: cursor)
            if samples.count == 4096 {
                batch.packets.append(DesktopPCMPacket(firstFrame: packetStart, samples: samples))
                for i in samples.indices { samples[i] = 0 }
                samples.removeAll(keepingCapacity: true); packetStart = outputFrames
            }
        }
        if !samples.isEmpty { batch.packets.append(DesktopPCMPacket(firstFrame: packetStart, samples: samples)) }
        return batch
    }

    mutating func clear() { microphone.clear(); system.clear() }
}
